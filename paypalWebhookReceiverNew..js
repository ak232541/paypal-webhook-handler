const functions = require("firebase-functions");

// This is an ULTRA-MINIMAL test function.
// It has NO Firebase Admin or PubSub initialization in the global scope.
// Its sole purpose is to see if *any* function can start up.

console.log("paypalWebhookReceiverNew (ULTRA-MINIMAL TEST): Function file loaded and global scope executed.");

exports.paypalWebhookReceivernew = functions.https.onRequest(async (req, res) => {
    console.log("paypalWebhookReceiverNew (ULTRA-MINIMAL TEST): HTTP Request received inside handler.");
    // We'll also log the request body for initial checks if it ever gets this far
    console.log("paypalWebhookReceiverNew (ULTRA-MINIMAL TEST): Request body:", req.body ? JSON.stringify(req.body).substring(0, 200) : "No body");
    return res.status(200).send("Hello from paypalWebhookReceiverNew (ULTRA-MINIMAL TEST)!");
});

console.log("paypalWebhookReceiverNew (ULTRA-MINIMAL TEST): Function handler defined and exported.");