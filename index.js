// index.js
require('dotenv').config(); // Loads environment variables from a .env file
const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment');
const cron = require('node-cron');
const { MessagingResponse } = require('twilio').twiml;
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// Parse URL-encoded bodies (as sent by Twilio)
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize SupaBase client with your credentials
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Initialize Twilio client with your credentials
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * Helper function to send a TwiML response back to Twilio.
 */
function sendTwimlResponse(res, message) {
  const twiml = new MessagingResponse();
  twiml.message(message);
  res.set('Content-Type', 'text/xml');
  res.send(twiml.toString());
}

/**
 * POST /sms endpoint
 * This is the webhook endpoint that Twilio will call when an SMS is received.
 */
app.post('/sms', async (req, res) => {
  try {
    const incomingMsg = req.body.Body.trim();
    const fromNumber = req.body.From; // the sender's phone number
    console.log(`Received SMS from ${fromNumber}: ${incomingMsg}`);

    // If the user texts "total", send the total cash collected.
    if (incomingMsg.toLowerCase() === 'total') {
      const { data, error } = await supabase
        .from('cash_entries')
        .select('amount');
      if (error) {
        console.error('Database error:', error);
        return sendTwimlResponse(res, 'An error occurred while retrieving data. Please try again later.');
      }
      const total = data.reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      return sendTwimlResponse(res, `Total cash collected: $${total.toFixed(2)}`);
    }

    // Check if the message is a valid numeric cash entry.
    const numberRegex = /^\d+(\.\d+)?$/;
    if (numberRegex.test(incomingMsg)) {
      const amount = parseFloat(incomingMsg);
      // Insert the cash entry into the database
      const { error } = await supabase
        .from('cash_entries')
        .insert([{ phone: fromNumber, amount }]);
      if (error) {
        console.error('Database error:', error);
        return sendTwimlResponse(res, 'An error occurred while saving your entry. Please try again later.');
      }
      return sendTwimlResponse(res, 'Your cash entry has been recorded.');
    }

    // Attempt to interpret the message as a date query.
    // Supported input formats: "March 2023", "Mar 2023", "03/2023", "3/2023", "03/15/2023", etc.
    const formats = ['MMMM YYYY', 'MMM YYYY', 'MM/YYYY', 'M/YYYY', 'MM/DD/YYYY', 'M/D/YYYY'];
    let dateQuery = moment(incomingMsg, formats, true);

    // If strict parsing fails, try appending the current year (in case the user typed only a month)
    if (!dateQuery.isValid()) {
      dateQuery = moment(incomingMsg + ' ' + moment().year(), ['MMMM YYYY', 'MMM YYYY'], true);
    }

    if (dateQuery.isValid()) {
      // Extract month and year from the parsed date.
      const queryMonth = dateQuery.month(); // moment months are 0-indexed (0 = January)
      const queryYear = dateQuery.year();

      // Define the start and end of the month.
      const startDate = moment({ year: queryYear, month: queryMonth, day: 1 }).toISOString();
      const endDate = moment({ year: queryYear, month: queryMonth }).endOf('month').toISOString();

      // Query the database for all entries within that month.
      const { data, error } = await supabase
        .from('cash_entries')
        .select('amount')
        .gte('created_at', startDate)
        .lte('created_at', endDate);

      if (error) {
        console.error('Database error:', error);
        return sendTwimlResponse(res, 'An error occurred while retrieving data. Please try again later.');
      }
      const monthlyTotal = data.reduce((sum, entry) => sum + parseFloat(entry.amount), 0);
      return sendTwimlResponse(
        res,
        `Total cash for ${dateQuery.format('MMMM YYYY')}: $${monthlyTotal.toFixed(2)}`
      );
    }

    // If none of the inputs match, reply with an error message.
    return sendTwimlResponse(
      res,
      'Invalid input. Please send a number, a valid date (e.g., "March 2023" or "03/2023"), or "total".'
    );
  } catch (err) {
    console.error('Server error:', err);
    return sendTwimlResponse(res, 'An unexpected error occurred. Please try again later.');
  }
});

// A simple health-check endpoint.
app.get('/', (req, res) => {
  res.send('SMS Tracker App is running.');
});

// *** SCHEDULED TASK USING node-cron ***
// This will send an SMS prompt every Tuesday through Saturday at 4:30 pm EST.
cron.schedule(
    // Cron expression breakdown:
    // ┌───────────── minute (30)
    // │ ┌──────────── hour (16 => 4 pm)
    // │ │ ┌────────── day of month (*, every day)
    // │ │ │ ┌──────── month (*, every month)
    // │ │ │ │ ┌────── day of week (2-6 => Tue-Sat)
    // │ │ │ │ │
    '30 16 * * 2-6',
    async () => {
      try {
        const userPhoneNumber = process.env.USER_PHONE_NUMBER;
        if (!userPhoneNumber) {
          console.error('USER_PHONE_NUMBER not configured.');
          return;
        }
        // Send SMS using Twilio
        const message = await twilioClient.messages.create({
          body: 'How much cash did you make today?',
          from: process.env.TWILIO_PHONE_NUMBER,
          to: userPhoneNumber,
        });
        console.log('Scheduled SMS sent:', message.sid);
      } catch (err) {
        console.error('Error sending scheduled SMS:', err);
      }
    },
    {
      timezone: 'America/New_York', // Ensures the schedule runs at 4:30 pm EST
    }
  );
  

// Start the server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
