import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as paypal from '@paypal/checkout-server-sdk';
import { onSchedule } from 'firebase-functions/v2/scheduler'; // Import onSchedule from v2

admin.initializeApp();
const db = admin.firestore();

// IMPORTANT: These PayPal credentials MUST be set in Firebase Functions config
// Run: firebase functions:config:set paypal.client_id="YOUR_PAYPAL_CLIENT_ID" paypal.client_secret="YOUR_PAYPAL_CLIENT_SECRET"
const CLIENT_ID = functions.config().paypal.client_id;
const CLIENT_SECRET = functions.config().paypal.client_secret;

// Ensure credentials are present before proceeding
if (!CLIENT_ID || !CLIENT_SECRET) {
    functions.logger.error('PayPal API credentials are not set in Firebase Functions config.');
    throw new Error('PayPal API credentials are not set. Deployment will fail or function will not work correctly.');
}

const environment = new paypal.core.SandboxEnvironment(CLIENT_ID, CLIENT_SECRET); // Use Sandbox for testing
const client = new paypal.core.PayPalHttpClient(environment);

// Interface for the data expected by createPayPalOrder callable function
interface PayPalOrderData {
    selectedTierId: string;
    userId: string;
}

/**
 * createPayPalOrder: HTTPS Callable function to create a PayPal order.
 * Called by the frontend to initiate a payment.
 * For v2 callable functions, the argument is a single CallableRequest object.
 */
export const createPayPalOrder = functions.https.onCall(async (request: functions.https.CallableRequest<PayPalOrderData>) => {
    functions.logger.info('createPayPalOrder: Function started.', { data: request.data, auth: request.auth?.uid });

    // Ensure the user is authenticated from the request context
    if (!request.auth || !request.auth.uid) {
        functions.logger.error('Unauthenticated call to createPayPalOrder.');
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated to create an order.');
    }

    // Destructure data from the request.data object
    const { selectedTierId, userId } = request.data;

    // Validate input
    if (!selectedTierId) {
        functions.logger.error('Invalid argument: selectedTierId is missing.', { userId: request.auth.uid });
        throw new functions.https.HttpsError('invalid-argument', 'Payment tier is required.');
    }

    // Define your payment tiers and their corresponding prices/currencies.
    // Ensure the currency matches your PayPal business account's primary currency.
    const paymentTiers: { [key: string]: { currency_code: string; value: string; description: string; } } = {
        'local': { currency_code: 'USD', value: '50.00', description: 'Local (Botswana Citizens) Membership' },
        'sadc': { currency_code: 'USD', value: '100.00', description: 'SADC Citizens Membership' },
        'global': { currency_code: 'USD', value: '380.00', description: 'Access for international users' },
    };

    const selectedTier = paymentTiers[selectedTierId];

    if (!selectedTier) {
        functions.logger.error('Invalid payment tier selected.', { selectedTierId, userId: request.auth.uid });
        throw new functions.https.HttpsError('invalid-argument', 'Invalid payment tier selected.');
    }

    functions.logger.info(`Creating PayPal order for User: ${userId}, Tier: ${selectedTierId}, Amount: ${selectedTier.value} ${selectedTier.currency_code}`);

    const payPalRequest = new paypal.orders.OrdersCreateRequest(); // Renamed to avoid conflict with 'request' parameter
    payPalRequest.prefer('return=representation');
    payPalRequest.requestBody({
        intent: 'CAPTURE', // CAPTURE means direct payment
        purchase_units: [{
            reference_id: userId, // Use reference_id to link to our user
            amount: {
                currency_code: selectedTier.currency_code,
                value: selectedTier.value
            },
            description: selectedTier.description,
            soft_descriptor: `Membership:${selectedTierId}`
        }],
        application_context: {
            // These URLs are where PayPal redirects the user after payment.
            // Replace with your actual deployed app URLs (e.g., Firebase Hosting URL)
            return_url: `https://guided-botswana.web.app/payment-success?userId=${userId}&tier=${selectedTierId}`,
            cancel_url: `https://guided-botswana.web.app/payment-cancel?userId=${userId}`,
            brand_name: "Explore Botswana",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW"
        }
    });

    try {
        const order = await client.execute(payPalRequest); // Use payPalRequest here
        const approvalUrl = order.result.links.find((link: any) => link.rel === 'approve').href;
        functions.logger.info('PayPal Order created successfully, redirecting.', { orderId: order.result.id, approvalUrl });
        return { redirectUrl: approvalUrl, orderId: order.result.id };
    } catch (error: any) {
        functions.logger.error('Error creating PayPal order:', {
            statusCode: error.statusCode,
            name: error.name,
            message: error.message,
            details: error.result?.details,
            debug_id: error.result?.debug_id
        });
        throw new functions.https.HttpsError('internal', 'Failed to create PayPal order.', error.message);
    }
});

/**
 * paypalWebhookHandler: HTTPS Endpoint function for PayPal webhooks.
 * PayPal sends payment notifications here. You must configure this URL in PayPal Developer Dashboard.
 * URL will be: `https://your-region-your-project-id.cloudfunctions.net/paypalWebhookHandler`
 */
export const paypalWebhookHandler = functions.https.onRequest(async (req, res) => {
    functions.logger.info('paypalWebhookHandler: Webhook received.', { eventType: req.body?.event_type, method: req.method });

    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    // IMPORTANT: In production, ALWAYS verify the webhook signature!
    // This example skips it for simplicity during initial setup.
    // Example: https://developer.paypal.com/docs/api/webhooks/rest/v1/#verify-webhook-signature

    const eventType = req.body.event_type;
    const resource = req.body.resource;

    try {
        switch (eventType) {
            case 'CHECKOUT.ORDER.COMPLETED': // This is a common event for successful payments
            case 'CHECKOUT.ORDER.APPROVED':
            case 'PAYMENT.CAPTURE.COMPLETED':
                const orderId = resource.id;
                // We used `reference_id` in the purchase unit to store userId.
                // It might be in `resource.purchase_units[0].reference_id` or `custom_id` depending on setup.
                const userId = resource.purchase_units?.[0]?.reference_id || resource.purchase_units?.[0]?.custom_id;
                const payerEmail = resource.payer?.email_address;
                const grossAmount = parseFloat(resource.purchase_units?.[0]?.amount?.value || '0');
                const currencyCode = resource.purchase_units?.[0]?.amount?.currency_code;
                const paymentStatus = resource.status;

                functions.logger.info(`Payment ${paymentStatus} via webhook for Order ID: ${orderId}, User ID: ${userId}`, {
                    grossAmount,
                    currencyCode,
                    payerEmail
                });

                if (userId && (paymentStatus === 'COMPLETED' || paymentStatus === 'APPROVED')) {
                    const userRef = db.collection('users').doc(userId);
                    await db.runTransaction(async (transaction) => {
                        const userDoc = await transaction.get(userRef);
                        if (!userDoc.exists) {
                            functions.logger.warn(`User document not found for webhook customId: ${userId}.`);
                            // Potentially create a basic user record if not found, or just log.
                            return; // Exit transaction if user not found
                        }

                        const userData = userDoc.data();
                        const salespersonFullName = userData?.salesperson?.fullName;

                        // Calculate expiry date: 2 weeks from now
                        const newExpiryDate = admin.firestore.Timestamp.fromMillis(Date.now() + (14 * 24 * 60 * 60 * 1000));

                        // Update user's payment status and membership expiry in Firestore
                        // Note: selectedTierId is NOT available in webhook context unless specifically passed by PayPal which is not standard.
                        // We can try to infer it or just mark as 'unknown' if not critical.
                        transaction.update(userRef, {
                            paymentStatus: 'paid',
                            membershipExpiry: newExpiryDate,
                            // paymentTier: selectedTierId || 'unknown', // Removed as selectedTierId is from CallableRequest, not webhook
                            lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
                            paypalOrderId: orderId,
                            paypalPayerEmail: payerEmail,
                            paypalGrossAmount: grossAmount,
                            paypalCurrencyCode: currencyCode
                        });

                        // Update salesperson's commission
                        if (salespersonFullName) {
                            const commissionRate = 0.20; // 20% commission
                            const commissionEarned = grossAmount * commissionRate;
                            const salespersonRef = db.collection('salespersons').doc(salespersonFullName);

                            const spDoc = await transaction.get(salespersonRef);
                            if (spDoc.exists) {
                                transaction.update(salespersonRef, {
                                    currentMonthEarnings: admin.firestore.FieldValue.increment(commissionEarned),
                                    totalSales: admin.firestore.FieldValue.increment(1),
                                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                                });
                                functions.logger.info(`Salesperson ${salespersonFullName} earnings updated: +${commissionEarned}.`);
                            } else {
                                functions.logger.warn(`Salesperson document missing for ${salespersonFullName}. Creating new record.`);
                                transaction.set(salespersonRef, {
                                    firstName: salespersonFullName.split(' ')[0] || null, // Best guess
                                    lastName: salespersonFullName.split(' ')[1] || null, // Best guess
                                    fullName: salespersonFullName,
                                    currentMonthEarnings: commissionEarned,
                                    totalSales: 1,
                                    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                                });
                            }
                            // Optionally, log individual sale for detailed monthly payouts
                            const currentMonth = new Date().toISOString().substring(0, 7); //YYYY-MM
                            const individualSaleRef = salespersonRef.collection('monthlyPayouts').doc(currentMonth).collection('individualSales').doc();
                            transaction.set(individualSaleRef, {
                                userId: userId,
                                orderId: orderId,
                                amount: grossAmount,
                                commission: commissionEarned,
                                timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                        } else {
                            functions.logger.info(`User ${userId} has no associated salesperson.`);
                        }
                    });
                }
                break;

            case 'PAYMENT.CAPTURE.DENIED':
                functions.logger.warn('Payment Capture Denied:', { orderId: resource.id, userId: resource.purchase_units?.[0]?.reference_id });
                // Handle denied payments (e.g., update user status in Firestore to 'payment_denied')
                break;
            case 'BILLING.SUBSCRIPTION.CANCELLED':
            case 'BILLING.SUBSCRIPTION.EXPIRED':
                functions.logger.info(`Subscription ${resource.id} ${eventType}.`);
                // Find user by subscription ID and update their membership status
                break;
            default:
                functions.logger.info(`Unhandled webhook event type: ${eventType}.`);
        }
        res.status(200).send('Webhook processed.');
    } catch (error: any) {
        functions.logger.error('Error processing PayPal webhook:', error);
        res.status(500).send('Internal Server Error processing webhook.');
    }
});

/**
 * resetMonthlyEarnings: Scheduled Pub/Sub function to reset salesperson earnings monthly.
 * Configured in firebase.json.
 */
export const resetMonthlyEarnings = onSchedule({
    schedule: '0 0 1 * *', // At 00:00 on day 1 of every month
    timeZone: 'Africa/Johannesburg' // Set to your desired timezone
}, async (context) => {
    functions.logger.info('Running monthly earnings reset for salespersons.');

    const salespersonsRef = db.collection('salespersons');
    const snapshot = await salespersonsRef.get();

    const batch = db.batch();
    const currentMonth = new Date().toISOString().substring(0, 7); //YYYY-MM for archiving

    snapshot.forEach(doc => {
        const salespersonData = doc.data();
        const currentMonthEarnings = salespersonData?.currentMonthEarnings || 0;
        const totalSales = salespersonData?.totalSales || 0; // Assuming this is for current month's count

        // Archive current month's earnings if any
        if (currentMonthEarnings > 0 || totalSales > 0) {
            const historicalRef = doc.ref.collection('historicalPayouts').doc(currentMonth);
            batch.set(historicalRef, {
                month: currentMonth,
                earnings: currentMonthEarnings,
                totalCustomers: totalSales,
                archivedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true }); // Use merge to avoid overwriting if run multiple times
            functions.logger.info(`Archived earnings for ${doc.id} for month ${currentMonth}.`);
        }

        // Reset current month's earnings and sales count
        batch.update(doc.ref, {
            currentMonthEarnings: 0,
            totalSales: 0 // Resetting monthly sales count
        });
        functions.logger.info(`Resetting currentMonthEarnings for ${doc.id}.`);
    });

    await batch.commit();
    functions.logger.info('Monthly earnings reset complete.');
});

/**
 * getSalespersonData: HTTPS Callable function to retrieve salesperson data.
 * Can be used by an admin frontend.
 * For v2 callable functions, the argument is a single CallableRequest object.
 */
export const getSalespersonData = functions.https.onCall(async (request: functions.https.CallableRequest<any>) => {
    // Implement robust authorization here (e.g., only specific roles can call this)
    if (!request.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
    }
    // Example: Check if the user has an 'admin' role in their Firestore user profile
    // const callingUserDoc = await db.collection('users').doc(request.auth.uid).get();
    // if (!callingUserDoc.exists || callingUserDoc.data()?.role !== 'admin') {
    //     throw new functions.https.HttpsError('permission-denied', 'Access denied. Admin privileges required.');
    // }

    functions.logger.info('Fetching all salesperson data.');
    const salespersons: admin.firestore.DocumentData[] = [];
    try {
        const snapshot = await db.collection('salespersons').get();
        for (const doc of snapshot.docs) {
            const spData = doc.data();
            // Fetch only the most recent monthly payout if needed, not all historical
            const monthlyPayoutsSnapshot = await doc.ref.collection('monthlyPayouts').orderBy('month', 'desc').limit(1).get();
            let currentMonthPayout = null;
            if (!monthlyPayoutsSnapshot.empty) {
                currentMonthPayout = monthlyPayoutsSnapshot.docs[0].data();
            }
            salespersons.push({
                id: doc.id,
                ...spData,
                currentMonthPayout: currentMonthPayout // Include current month's payout if available
            });
        }
        functions.logger.info(`Fetched ${salespersons.length} salesperson records.`);
        return { salespersons };
    } catch (error) {
        functions.logger.error('Error fetching salesperson data:', error);
        throw new functions.https.HttpsError('internal', 'Failed to retrieve salesperson data.');
    }
});