/**
 * Firebase Functions for Explore Botswana Application.
 * This file contains two main functions:
 * 1. `createPayPalOrder`: A callable HTTP function initiated by the frontend
 * to create a PayPal order.
 * 2. `paypalWebhookHandler`: A Pub/Sub triggered function that processes
 * PayPal webhook events (e.g., payment approved) to update user subscriptions
 * and track salesperson commissions in Firestore.
 *
 * This version uses 2nd Generation Firebase Functions syntax for the Pub/Sub handler.
 * The `createPayPalOrder` function has been temporarily simplified to diagnose issues.
 */

// Import necessary Firebase modules for 1st Gen functions (for createPayPalOrder, reports)
const functions = require('firebase-functions');
// Import specific modules for 2nd Gen Pub/Sub functions
const { onMessagePublished } = require('firebase-functions/v2/pubsub');
const { setGlobalOptions } = require('firebase-functions/v2'); // For global options like region

const admin = require('firebase-admin');
const { log, info, error, warn } = require('firebase-functions/logger');

// Import PayPal SDK (make sure to install it: npm install @paypal/checkout-server-sdk)
// IMPORTANT: This line is kept, but its usage below is commented out.
const paypal = require('@paypal/checkout-server-sdk');

// Initialize Firebase Admin SDK if it hasn't been already
if (admin.apps.length === 0) {
    admin.initializeApp();
}

// Firestore database instance
const db = admin.firestore();

// Set global options for 2nd Gen functions (e.g., region)
// Ensure this matches the region you prefer for your functions (e.g., 'europe-west1', 'us-central1')
setGlobalOptions({ region: 'us-central1' }); 

/* --- TEMPORARILY COMMENT OUT PAYPAL CLIENT SETUP FOR DIAGNOSIS --- */
// const PAYPAL_CLIENT_ID = functions.config().paypal?.client_id || 'YOUR_PAYPAL_SANDBOX_CLIENT_ID';
// const PAYPAL_CLIENT_SECRET = functions.config().paypal?.client_secret || 'YOUR_PAYPAL_SANDBOX_SECRET';
// const environment = new paypal.core.SandboxEnvironment(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET);
// const client = new paypal.core.PayPalHttpClient(environment);
/* --- END TEMPORARY COMMENT OUT --- */


// Define payment tiers and their prices
const paymentTiers = {
    'local': { price: 50, currency: 'BWP', description: 'Local (Botswana Citizens) Access' }, // Assuming BWP is Botswana Pula
    'sadc': { price: 100, currency: 'BWP', description: 'SADC Citizens Access' },
    'global': { price: 380, currency: 'USD', description: 'Global Citizens Access' }, // Assuming international is USD
};

/**
 * Firebase Callable Function: createPayPalOrder (1st Gen) - SIMPLIFIED FOR TEST
 * Initiates a PayPal order from the frontend.
 *
 * @param {object} data - The data sent from the frontend.
 * @param {string} data.userId - The Firebase UID of the user initiating the payment.
 * @param {string} data.selectedTierId - The ID of the selected payment tier ('local', 'sadc', 'global').
 * @returns {Promise<object>} - An object containing redirectUrl and orderId on success, or an error message.
 */
exports.createPayPalOrder = functions.https.onCall(async (data, context) => {
    info("createPayPalOrder: Callable function invoked (SIMPLIFIED FOR TEST).");

    // 1. Authenticate user
    if (!context.auth) {
        error("createPayPalOrder: Unauthenticated request.");
        throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated to create an order.');
    }

    const userId = data.userId;
    const selectedTierId = data.selectedTierId;

    if (!userId || !selectedTierId) {
        error("createPayPalOrder: Missing userId or selectedTierId in request data.");
        throw new functions.https.HttpsError('invalid-argument', 'Missing user ID or selected tier ID.');
    }

    const tierInfo = paymentTiers[selectedTierId];
    if (!tierInfo) {
        error(`createPayPalOrder: Invalid selectedTierId: ${selectedTierId}`);
        throw new functions.https.HttpsError('invalid-argument', 'Invalid payment tier selected.');
    }

    // 2. Fetch salesperson ID from user profile (needed for custom_id) - Keep this part
    let salespersonId = 'unknown_salesperson'; // Default if not found
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().salespersonId) {
            salespersonId = userDoc.data().salespersonId;
            info(`createPayPalOrder: Found salespersonId ${salespersonId} for user ${userId}`);
        } else {
            warn(`createPayPalOrder: Salesperson ID not found for user ${userId}. Using default.`);
        }
    } catch (err) {
        error(`createPayPalOrder: Error fetching salespersonId for user ${userId}:`, err);
        // Continue even if salesperson ID fetch fails, payment should still proceed
    }

    info(`SIMULATED: Would create order for userId: ${userId}, tier: ${selectedTierId}, price: ${tierInfo.price} ${tierInfo.currency}`);

    /* --- TEMPORARILY COMMENT OUT PAYPAL API CALL FOR DIAGNOSIS --- */
    // const request = new paypal.orders.OrdersCreateRequest();
    // request.prefer('return=representation');
    // request.requestBody({
    //     intent: 'CAPTURE',
    //     purchase_units: [{
    //         amount: {
    //             currency_code: tierInfo.currency,
    //             value: tierInfo.price.toFixed(2),
    //         },
    //         custom_id: `${userId}_${salespersonId}`,
    //         description: selectedTierId,
    //         soft_descriptor: 'EXPLOREBOTSWANA',
    //     }],
    //     application_context: {
    //         return_url: 'YOUR_FRONTEND_SUCCESS_URL',
    //         cancel_url: 'YOUR_FRONTEND_CANCEL_URL',
    //         brand_name: 'Explore Botswana',
    //         landing_page: 'BILLING',
    //         user_action: 'PAY_NOW',
    //     },
    // });

    // try {
    //     const order = await client.execute(request);
    //     info("createPayPalOrder: PayPal Order created successfully:", order.result.id);
    //     const redirectUrl = order.result.links.find(link => link.rel === 'approve').href;
    //     return { redirectUrl: redirectUrl, orderId: order.result.id };
    // } catch (err) {
    //     error("createPayPalOrder: Error creating PayPal order:", err.statusCode, err.message);
    //     if (err.debug_id) {
    //         error("PayPal Debug ID:", err.debug_id);
    //     }
    //     throw new functions.https.HttpsError('internal', 'Failed to create PayPal order.', err.message);
    // }
    /* --- END TEMPORARY COMMENT OUT --- */

    // Return a simulated success response
    return { redirectUrl: "https://example.com/simulated-paypal-redirect", orderId: "SIMULATED_ORDER_ID" };
});


/**
 * Firebase Pub/Sub Triggered Function: paypalWebhookHandler (2nd Gen)
 * Processes PayPal webhook events to update user subscriptions and sales commissions.
 * This function is triggered by a Pub/Sub topic where PayPal webhook events are pushed.
 *
 * @param {object} event - The CloudEvent containing the Pub/Sub message.
 */
exports.paypalWebhookHandler = onMessagePublished({
    topic: 'paypal-webhooks',
    // You can specify other options like 'region' here if not set globally
    // region: 'us-central1',
    // maxInstances: 1, // Limit concurrent instances for sensitive operations
}, async (event) => {
    info("paypalWebhookHandler: Pub/Sub message received (2nd Gen).");

    let webhookPayload;
    try {
        // The Pub/Sub message data is directly available in event.data.message.data
        const messageData = event.data.message.data ? Buffer.from(event.data.message.data, 'base64').toString() : '{}';
        webhookPayload = JSON.parse(messageData);

        info("paypalWebhookHandler: Successfully parsed webhook payload.");
        info("paypalWebhookHandler: Parsed webhook payload (summary):", webhookPayload.summary);
        info("paypalWebhookHandler: Parsed webhook payload (event_type):", webhookPayload.event_type);
        info("paypalWebhookHandler: Parsed webhook payload (resource ID):", webhookPayload.resource ? webhookPayload.resource.id : 'N/A');

        // Process only 'CHECKOUT.ORDER.APPROVED' events for subscription updates
        if (webhookPayload.event_type === 'CHECKOUT.ORDER.APPROVED') {
            info('paypalWebhookHandler: Handling CHECKOUT.ORDER.APPROVED event.');

            const orderId = webhookPayload.resource.id;
            const amountValue = webhookPayload.resource.purchase_units[0].amount.value;
            const currencyCode = webhookPayload.resource.purchase_units[0].amount.currency_code;
            const payerEmail = webhookPayload.resource.payer.email_address;

            // Extract custom_id and description from purchase_units
            const customId = webhookPayload.resource.purchase_units[0].custom_id; // Format: "userId_salespersonId"
            const selectedTierId = webhookPayload.resource.purchase_units[0].description; // Format: "local", "sadc", "global"

            if (!customId || !selectedTierId) {
                warn(`paypalWebhookHandler: Missing custom_id or description in webhook payload for Order ID: ${orderId}. Cannot update user/salesperson.`);
                return; // Exit if crucial data is missing
            }

            const [userId, salespersonId] = customId.split('_');

            if (!userId || !salespersonId) {
                 warn(`paypalWebhookHandler: Malformed custom_id: ${customId} for Order ID: ${orderId}. Cannot parse userId or salespersonId.`);
                 return;
            }

            info(`paypalWebhookHandler: Extracted userId: ${userId}, selectedTierId: ${selectedTierId}, salespersonId: ${salespersonId}`);

            // 1. Update User's Subscription Status in Firestore
            const userDocRef = db.collection('users').doc(userId);
            const twoWeeksInMs = 14 * 24 * 60 * 60 * 1000;
            const membershipExpiry = admin.firestore.Timestamp.fromMillis(Date.now() + twoWeeksInMs);

            await userDocRef.update({
                paymentStatus: 'paid',
                membershipExpiry: membershipExpiry,
                lastPaymentAmount: amountValue,
                lastPaymentCurrency: currencyCode,
                lastPaymentDate: admin.firestore.FieldValue.serverTimestamp(), // Use server timestamp for accuracy
                paypalOrderId: orderId,
                selectedTier: selectedTierId,
            });
            info(`paypalWebhookHandler: User ${userId} subscription updated. Expires: ${membershipExpiry.toDate().toISOString()}`);

            // 2. Calculate and Update Salesperson Commission
            const tierPrice = paymentTiers[selectedTierId]?.price;
            if (!tierPrice) {
                warn(`paypalWebhookHandler: Tier price not found for selectedTierId: ${selectedTierId}. Cannot calculate commission.`);
                return; // Exit if tier price is unknown
            }

            const commissionRate = 0.10; // 10% commission
            const commissionAmount = parseFloat(amountValue) * commissionRate; // Use the actual paid amount

            info(`paypalWebhookHandler: Calculating commission for salesperson ${salespersonId}: ${commissionAmount.toFixed(2)} ${currencyCode}`);

            // Get current date for monthly/yearly aggregation
            const now = new Date();
            const year = now.getFullYear().toString();
            const month = (now.getMonth() + 1).toString().padStart(2, '0'); // 01-12
            const yearMonth = `${year}-${month}`;

            const salespersonDocRef = db.collection('salespersons').doc(salespersonId);

            // Use a transaction to ensure atomic updates for commission totals
            await db.runTransaction(async (transaction) => {
                const salespersonDoc = await transaction.get(salespersonDocRef);

                if (!salespersonDoc.exists) {
                    // Create salesperson document if it doesn't exist
                    transaction.set(salespersonDocRef, {
                        name: salespersonId, // You might want to store actual names elsewhere
                        totalCommission: commissionAmount,
                        monthlyCommission: {
                            [yearMonth]: commissionAmount,
                        },
                        yearlyCommission: {
                            [year]: commissionAmount,
                        },
                        lastSaleDate: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    info(`paypalWebhookHandler: Created new salesperson document for ${salespersonId}`);
                } else {
                    const data = salespersonDoc.data();
                    const currentTotal = data.totalCommission || 0;
                    const currentMonthly = (data.monthlyCommission && data.monthlyCommission[yearMonth]) || 0;
                    const currentYearly = (data.yearlyCommission && data.yearlyCommission[year]) || 0;

                    transaction.update(salespersonDocRef, {
                        totalCommission: currentTotal + commissionAmount,
                        [`monthlyCommission.${yearMonth}`]: currentMonthly + commissionAmount,
                        [`yearlyCommission.${year}`]: currentYearly + commissionAmount,
                        lastSaleDate: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    info(`paypalWebhookHandler: Updated salesperson ${salespersonId} commissions.`);
                }
            });

            info(`paypalWebhookHandler: Successfully processed CHECKOUT.ORDER.APPROVED for Order ID: ${orderId}`);

        } else if (webhookPayload.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
            // This event often follows CHECKOUT.ORDER.APPROVED,
            // You might choose to handle it if you need more granular control
            // but for simple subscription, APPROVED is usually sufficient.
            info('paypalWebhookHandler: Handling PAYMENT.CAPTURE.COMPLETED event. (No action taken as APPROVED handles subscription).');
        } else {
            warn(`paypalWebhookHandler: Unhandled webhook event type: ${webhookPayload.event_type || 'undefined'}.`);
        }

    } catch (err) {
        error('paypalWebhookHandler: Error processing Pub/Sub message:', err);
        // Throwing an error here will cause Pub/Sub to retry the message,
        // which is good for transient errors but can lead to infinite retries for persistent ones.
        throw new Error(`Error processing message: ${err.message}`);
    }

    info("paypalWebhookHandler: Finished processing Pub/Sub message.");
});


// --- Sales Reporting Functions (1st Gen) ---

/**
 * HTTPS Callable Function: getMonthlySalesReport
 * Retrieves monthly sales and commission data for a given salesperson and month.
 *
 * @param {object} data - The data sent from the frontend.
 * @param {string} data.salespersonId - The ID of the salesperson.
 * @param {string} data.yearMonth - The year and month in YYYY-MM format (e.g., '2023-10').
 * @returns {Promise<object>} - Monthly sales report data.
 */
exports.getMonthlySalesReport = functions.https.onCall(async (data, context) => {
    info("getMonthlySalesReport: Callable function invoked.");

    // Basic authentication and authorization (TODO: Enhance security rules)
    if (!context.auth) {
        error("getMonthlySalesReport: Unauthenticated request.");
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
    }
    // You might add roles-based authorization here, e.g., only 'admin' or the salesperson themselves can view

    const { salespersonId, yearMonth } = data;

    if (!salespersonId || !yearMonth) {
        error("getMonthlySalesReport: Missing salespersonId or yearMonth.");
        throw new functions.https.HttpsError('invalid-argument', 'Salesperson ID and year/month are required.');
    }

    try {
        const salespersonDoc = await db.collection('salespersons').doc(salespersonId).get();

        if (!salespersonDoc.exists) {
            warn(`getMonthlySalesReport: Salesperson ${salespersonId} not found.`);
            return { totalCommission: 0, sales: [], message: 'Salesperson not found or no sales data.' };
        }

        const salespersonData = salespersonDoc.data();
        const monthlyCommission = salespersonData.monthlyCommission?.[yearMonth] || 0;

        // Fetch individual sales for the specified month (assuming a 'sales' subcollection)
        const salesSnapshot = await db.collection('salespersons').doc(salespersonId)
            .collection('sales')
            .where('saleMonth', '==', yearMonth) // Assuming you store a 'saleMonth' field in YYYY-MM format
            .get();

        const sales = salesSnapshot.docs.map(doc => doc.data());

        info(`getMonthlySalesReport: Report generated for ${salespersonId} for ${yearMonth}.`);
        return {
            totalCommission: monthlyCommission,
            sales: sales,
        };

    } catch (err) {
        error("getMonthlySalesReport: Error fetching monthly sales report:", err);
        throw new functions.https.HttpsError('internal', 'Failed to retrieve monthly sales report.', err.message);
    }
});

/**
 * HTTPS Callable Function: getYearlySalesReport
 * Retrieves yearly sales and commission data for a given salesperson and year.
 *
 * @param {object} data - The data sent from the frontend.
 * @param {string} data.salespersonId - The ID of the salesperson.
 * @param {string} data.year - The year in YYYY format (e.g., '2023').
 * @returns {Promise<object>} - Yearly sales report data.
 */
exports.getYearlySalesReport = functions.https.onCall(async (data, context) => {
    info("getYearlySalesReport: Callable function invoked.");

    // Basic authentication and authorization (TODO: Enhance security rules)
    if (!context.auth) {
        error("getYearlySalesReport: Unauthenticated request.");
        throw new functions.https.HttpsError('unauthenticated', 'Authentication required.');
    }
    // You might add roles-based authorization here, e.g., only 'admin' or the salesperson themselves can view

    const { salespersonId, year } = data;

    if (!salespersonId || !year) {
        error("getYearlySalesReport: Missing salespersonId or year.");
        throw new functions.https.HttpsError('invalid-argument', 'Salesperson ID and year are required.');
    }

    try {
        const salespersonDoc = await db.collection('salespersons').doc(salespersonId).get();

        if (!salespersonDoc.exists) {
            warn(`getYearlySalesReport: Salesperson ${salespersonId} not found.`);
            return { totalCommission: 0, sales: [], message: 'Salesperson not found or no sales data.' };
        }

        const salespersonData = salespersonDoc.data();
        const yearlyCommission = salespersonData.yearlyCommission?.[year] || 0;

        // Fetch individual sales for the specified year (assuming a 'sales' subcollection)
        // Note: This might be inefficient for very large numbers of sales.
        // Consider aggregating sales into monthly/yearly subcollections if performance is an issue.
        const salesSnapshot = await db.collection('salespersons').doc(salespersonId)
            .collection('sales')
            .where('saleYear', '==', year) // Assuming you store a 'saleYear' field in YYYY format
            .get();

        const sales = salesSnapshot.docs.map(doc => doc.data());

        info(`getYearlySalesReport: Report generated for ${salespersonId} for ${year}.`);
        return {
            totalCommission: yearlyCommission,
            sales: sales,
        };

    } catch (err) {
        error("getYearlySalesReport: Error fetching yearly sales report:", err);
        throw new functions.https.HttpsError('internal', 'Failed to retrieve yearly sales report.', err.message);
    }
});
