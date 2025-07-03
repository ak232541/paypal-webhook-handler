    import * as admin from 'firebase-admin';
    import * as paypal from '@paypal/checkout-server-sdk';
    import { onSchedule } from 'firebase-functions/v2/scheduler';
    import { onCall, onRequest } from 'firebase-functions/v2/https'; // Import onCall and onRequest from v2/https

    admin.initializeApp();
    const db = admin.firestore();

    const CLIENT_ID = process.env.PAYPAL_CLIENT_ID; // Access env vars directly for v2
    const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET; // Access env vars directly for v2

    // Ensure credentials are present before proceeding
    if (!CLIENT_ID || !CLIENT_SECRET) {
        // For v2 functions, it's safer to throw this at module load if variables are critical.
        // Or handle within the function if it's possible for them to be missing after deploy.
        // For production, always ensure these are set via `firebase functions:secrets:set` or config.
        console.error('PayPal API credentials are not set as environment variables.');
        // Consider exiting if this is a hard dependency, or letting the function handle error
        // return; // Or throw new Error('...'); if you want deployment to fail immediately.
    }

    const environment = new paypal.core.SandboxEnvironment(CLIENT_ID!, CLIENT_SECRET!); // Use Sandbox for testing, add ! for non-null assertion
    const client = new paypal.core.PayPalHttpClient(environment);

    // Interface for the data expected by createPayPalOrder callable function
    interface PayPalOrderData {
        selectedTierId: string;
        userId: string;
    }

    /**
     * createPayPalOrder: HTTPS Callable function to create a PayPal order (v2).
     * Called by the frontend to initiate a payment.
     */
    export const createPayPalOrder = onCall<PayPalOrderData>(async (request) => { // Use onCall directly
        console.info('createPayPalOrder: Function started.', { data: request.data, auth: request.auth?.uid }); // Use console.info for v2 logs

        if (!request.auth || !request.auth.uid) {
            console.error('Unauthenticated call to createPayPalOrder.');
            throw new Error('User must be authenticated to create an order.'); // Use generic Error for callable
        }

        const { selectedTierId, userId } = request.data;

        if (!selectedTierId) {
            console.error('Invalid argument: selectedTierId is missing.', { userId: request.auth.uid });
            throw new Error('Payment tier is required.');
        }

        const paymentTiers: { [key: string]: { currency_code: string; value: string; description: string; } } = {
            'local': { currency_code: 'USD', value: '50.00', description: 'Local (Botswana Citizens) Membership' },
            'sadc': { currency_code: 'USD', value: '100.00', description: 'SADC Citizens Membership' },
            'global': { currency_code: 'USD', value: '380.00', description: 'Access for international users' },
        };

        const selectedTier = paymentTiers[selectedTierId];

        if (!selectedTier) {
            console.error('Invalid payment tier selected.', { selectedTierId, userId: request.auth.uid });
            throw new Error('Invalid payment tier selected.');
        }

        console.info(`Creating PayPal order for User: ${userId}, Tier: ${selectedTierId}, Amount: ${selectedTier.value} ${selectedTier.currency_code}`);

        const payPalRequest = new paypal.orders.OrdersCreateRequest();
        payPalRequest.prefer('return=representation');
        payPalRequest.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                reference_id: userId,
                amount: {
                    currency_code: selectedTier.currency_code,
                    value: selectedTier.value
                },
                description: selectedTier.description,
                soft_descriptor: `Membership:${selectedTierId}`
            }],
            application_context: {
                return_url: `https://guided-botswana.web.app/payment-success?userId=${userId}&tier=${selectedTierId}`,
                cancel_url: `https://guided-botswana.web.app/payment-cancel?userId=${userId}`,
                brand_name: "Explore Botswana",
                shipping_preference: "NO_SHIPPING",
                user_action: "PAY_NOW"
            }
        });

        try {
            const order = await client.execute(payPalRequest);
            const approvalUrl = order.result.links.find((link: any) => link.rel === 'approve').href;
            console.info('PayPal Order created successfully, redirecting.', { orderId: order.result.id, approvalUrl });
            return { redirectUrl: approvalUrl, orderId: order.result.id };
        } catch (error: any) {
            console.error('Error creating PayPal order:', {
                statusCode: error.statusCode,
                name: error.name,
                message: error.message,
                details: error.result?.details,
                debug_id: error.result?.debug_id
            });
            throw new Error('Failed to create PayPal order.'); // Use generic Error for callable
        }
    });

    /**
     * paypalWebhookHandler: HTTPS Endpoint function for PayPal webhooks (v2).
     * PayPal sends payment notifications here. You must configure this URL in PayPal Developer Dashboard.
     * URL will be: `https://your-region-your-project-id.cloudfunctions.net/paypalWebhookHandler`
     */
    export const paypalWebhookHandler = onRequest(async (req, res) => { // Use onRequest directly
        console.info('paypalWebhookHandler: Webhook received.', { eventType: req.body?.event_type, method: req.method });

        if (req.method !== 'POST') {
            res.status(405).send('Method Not Allowed');
            return;
        }

        const eventType = req.body.event_type;
        const resource = req.body.resource;

        try {
            switch (eventType) {
                case 'CHECKOUT.ORDER.COMPLETED':
                case 'CHECKOUT.ORDER.APPROVED':
                case 'PAYMENT.CAPTURE.COMPLETED':
                    const orderId = resource.id;
                    const userId = resource.purchase_units?.[0]?.reference_id || resource.purchase_units?.[0]?.custom_id;
                    const payerEmail = resource.payer?.email_address;
                    const grossAmount = parseFloat(resource.purchase_units?.[0]?.amount?.value || '0');
                    const currencyCode = resource.purchase_units?.[0]?.amount?.currency_code;
                    const paymentStatus = resource.status;

                    console.info(`Payment ${paymentStatus} via webhook for Order ID: ${orderId}, User ID: ${userId}`, {
                        grossAmount,
                        currencyCode,
                        payerEmail
                    });

                    if (userId && (paymentStatus === 'COMPLETED' || paymentStatus === 'APPROVED')) {
                        const userRef = db.collection('users').doc(userId);
                        await db.runTransaction(async (transaction) => {
                            const userDoc = await transaction.get(userRef);
                            if (!userDoc.exists) {
                                console.warn(`User document not found for webhook customId: ${userId}.`);
                                return;
                            }

                            const userData = userDoc.data();
                            const salespersonFullName = userData?.salesperson?.fullName;

                            const newExpiryDate = admin.firestore.Timestamp.fromMillis(Date.now() + (14 * 24 * 60 * 60 * 1000));

                            transaction.update(userRef, {
                                paymentStatus: 'paid',
                                membershipExpiry: newExpiryDate,
                                lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(),
                                paypalOrderId: orderId,
                                paypalPayerEmail: payerEmail,
                                paypalGrossAmount: grossAmount,
                                paypalCurrencyCode: currencyCode
                            });

                            if (salespersonFullName) {
                                const commissionRate = 0.20;
                                const commissionEarned = grossAmount * commissionRate;
                                const salespersonRef = db.collection('salespersons').doc(salespersonFullName);

                                const spDoc = await transaction.get(salespersonRef);
                                if (spDoc.exists) {
                                    transaction.update(salespersonRef, {
                                        currentMonthEarnings: admin.firestore.FieldValue.increment(commissionEarned),
                                        totalSales: admin.firestore.FieldValue.increment(1),
                                        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                                    });
                                    console.info(`Salesperson ${salespersonFullName} earnings updated: +${commissionEarned}.`);
                                } else {
                                    console.warn(`Salesperson document missing for ${salespersonFullName}. Creating new record.`);
                                    transaction.set(salespersonRef, {
                                        firstName: salespersonFullName.split(' ')[0] || null,
                                        lastName: salespersonFullName.split(' ')[1] || null,
                                        fullName: salespersonFullName,
                                        currentMonthEarnings: commissionEarned,
                                        totalSales: 1,
                                        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                                    });
                                }
                                const currentMonth = new Date().toISOString().substring(0, 7);
                                const individualSaleRef = salespersonRef.collection('monthlyPayouts').doc(currentMonth).collection('individualSales').doc();
                                transaction.set(individualSaleRef, {
                                    userId: userId,
                                    orderId: orderId,
                                    amount: grossAmount,
                                    commission: commissionEarned,
                                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                                });
                            } else {
                                console.info(`User ${userId} has no associated salesperson.`);
                            }
                        });
                    }
                    break;

                case 'PAYMENT.CAPTURE.DENIED':
                    console.warn('Payment Capture Denied:', { orderId: resource.id, userId: resource.purchase_units?.[0]?.reference_id });
                    break;
                case 'BILLING.SUBSCRIPTION.CANCELLED':
                case 'BILLING.SUBSCRIPTION.EXPIRED':
                    console.info(`Subscription ${resource.id} ${eventType}.`);
                    break;
                default:
                    console.info(`Unhandled webhook event type: ${eventType}.`);
            }
            res.status(200).send('Webhook processed.');
        } catch (error: any) {
            console.error('Error processing PayPal webhook:', error);
            res.status(500).send('Internal Server Error processing webhook.');
        }
    });

    /**
     * resetMonthlyEarnings: Scheduled Pub/Sub function to reset salesperson earnings monthly (v2).
     */
    export const resetMonthlyEarnings = onSchedule({
        schedule: '0 0 1 * *',
        timeZone: 'Africa/Johannesburg'
    }, async (context) => {
        console.info('Running monthly earnings reset for salespersons.');

        const salespersonsRef = db.collection('salespersons');
        const snapshot = await salespersonsRef.get();

        const batch = db.batch();
        const currentMonth = new Date().toISOString().substring(0, 7);

        snapshot.forEach(doc => {
            const salespersonData = doc.data();
            const currentMonthEarnings = salespersonData?.currentMonthEarnings || 0;
            const totalSales = salespersonData?.totalSales || 0;

            if (currentMonthEarnings > 0 || totalSales > 0) {
                const historicalRef = doc.ref.collection('historicalPayouts').doc(currentMonth);
                batch.set(historicalRef, {
                    month: currentMonth,
                    earnings: currentMonthEarnings,
                    totalCustomers: totalSales,
                    archivedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
                console.info(`Archived earnings for ${doc.id} for month ${currentMonth}.`);
            }

            batch.update(doc.ref, {
                currentMonthEarnings: 0,
                totalSales: 0
            });
            console.info(`Resetting currentMonthEarnings for ${doc.id}.`);
        });

        await batch.commit();
        console.info('Monthly earnings reset complete.');
    });

    /**
     * getSalespersonData: HTTPS Callable function to retrieve salesperson data (v2).
     */
    export const getSalespersonData = onCall(async (request) => { // Use onCall directly
        if (!request.auth) {
            throw new Error('Authentication required.');
        }

        console.info('Fetching all salesperson data.');
        const salespersons: admin.firestore.DocumentData[] = [];
        try {
            const snapshot = await db.collection('salespersons').get();
            for (const doc of snapshot.docs) {
                const spData = doc.data();
                const monthlyPayoutsSnapshot = await doc.ref.collection('monthlyPayouts').orderBy('month', 'desc').limit(1).get();
                let currentMonthPayout = null;
                if (!monthlyPayoutsSnapshot.empty) {
                    currentMonthPayout = monthlyPayoutsSnapshot.docs[0].data();
                }
                salespersons.push({
                    id: doc.id,
                    ...spData,
                    currentMonthPayout: currentMonthPayout
                });
            }
            console.info(`Fetched ${salespersons.length} salesperson records.`);
            return { salespersons };
        } catch (error: any) {
            console.error('Error fetching salesperson data:', error);
            throw new Error('Failed to retrieve salesperson data.');
        }
    });