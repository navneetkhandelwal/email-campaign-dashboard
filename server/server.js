// server.js
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/build')));

// Set up multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}_${file.originalname}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const filetypes = /csv|xlsx|xls/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only CSV, XLSX, and XLS files are allowed!'));
    }
  }
});

// Store active SSE connections
const clients = new Map();

// Email sending queue and process management
const emailJobs = new Map();

// Utility to create a nodemailer transporter
const createTransporter = (email, password) => {
  return nodemailer.createTransport({
    pool: true,
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: email,
      pass: password
    },
  });
};

// Handle CSV file processing
const processCSVFile = (filePath) => {
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);
    return data;
  } catch (error) {
    console.error('Error processing CSV file:', error);
    throw new Error('Failed to process CSV file');
  }
};

// API endpoint to receive email data and start the process
app.post('/api/send-emails', upload.single('file'), async (req, res) => {
  try {
    const { email, password, mode, userType } = req.body;
    const customEmailBody = req.body.customEmailBody || null;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email credentials are required' });
    }
    
    // Generate a unique ID for this job
    const jobId = uuidv4();
    
    let data = [];
    
    if (mode === 'csv') {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }
      data = processCSVFile(req.file.path);
    } else if (mode === 'manual') {
      if (!req.body.data) {
        return res.status(400).json({ success: false, message: 'No manual data provided' });
      }
      data = JSON.parse(req.body.data);
    }
    
    if (data.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid data found' });
    }
    
    // Store job data
    emailJobs.set(email, {
      jobId,
      data,
      email,
      password,
      userType,
      customEmailBody,
      status: 'preparing',
      total: data.length,
      current: 0,
      success: 0,
      failed: 0
    });
    
    // Start processing in the background
    setTimeout(() => {
      processEmailJob(email);
    }, 100);
    
    // Send immediate response
    res.status(200).json({ 
      success: true, 
      message: 'Email sending process started',
      jobId,
      total: data.length
    });
    
  } catch (error) {
    console.error('Error starting email sending process:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'Server error processing request' 
    });
  }
});

// SSE endpoint for real-time progress updates
app.get('/api/send-emails-sse', (req, res) => {
  const email = req.query.email;
  
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email parameter is required' });
  }
  
  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  // Send initial data if job exists
  const job = emailJobs.get(email);
  if (job) {
    const message = JSON.stringify({
      type: 'progress',
      total: job.total,
      current: job.current,
      success: job.success,
      failed: job.failed
    });
    res.write(`data: ${message}\n\n`);
  }
  
  // Add this client to our active connections
  const clientId = Date.now();
  const newClient = { id: clientId, email, res };
  clients.set(clientId, newClient);
  
  // Remove client on connection close
  req.on('close', () => {
    clients.delete(clientId);
  });
});

// Process email job
async function processEmailJob(email) {
  const job = emailJobs.get(email);
  if (!job) return;
  
  job.status = 'processing';
  
  // Create email transporter
  let transporter;
  try {
    transporter = createTransporter(job.email, job.password);
  } catch (error) {
    sendToClient(email, {
      type: 'log',
      message: `Error creating email transporter: ${error.message}`
    });
    
    sendToClient(email, {
      type: 'complete',
      success: 0,
      failed: job.total
    });
    
    emailJobs.delete(email);
    return;
  }
  
  sendToClient(email, {
    type: 'log',
    message: `Starting email sending process for ${job.total} recipients`
  });
  
  // Process each recipient
  for (let i = 0; i < job.data.length; i++) {
    const row = job.data[i];
    job.current = i + 1;
    
    try {
      // Skip rows with missing required fields
      if (!row.Name || !row.Email || !row.Company || !row.Role) {
        sendToClient(email, {
          type: 'log',
          message: `Skipping row ${i + 1}: Missing required fields`
        });
        job.failed++;
        continue;
      }
      
      // Send the email
      await sendEmail(transporter, row, job);
      job.success++;
      
      sendToClient(email, {
        type: 'log',
        message: `${i + 1}/${job.total}: Successfully sent email to ${row.Email}`
      });
      
    } catch (error) {
      job.failed++;
      sendToClient(email, {
        type: 'log',
        message: `${i + 1}/${job.total}: Failed to send email to ${row.Email}: ${error.message}`
      });
    }
    
    // Update progress
    sendToClient(email, {
      type: 'progress',
      total: job.total,
      current: job.current,
      success: job.success,
      failed: job.failed
    });
    
    // Wait between emails to avoid triggering spam filters
    if (i < job.data.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000)); // 3-second delay
    }
  }
  
  // Complete the job
  sendToClient(email, {
    type: 'complete',
    success: job.success,
    failed: job.failed
  });
  
  // Clean up
  emailJobs.delete(email);
}

// Send an individual email
// Fix the custom email template processing in the sendEmail function

async function sendEmail(transporter, row, job) {
    const { Name, Company, Email, Role, Link } = row;
    
    const nameParts = Name.split(' ');
    const firstName = nameParts[0];
    
    // Determine which email template to use
    let emailTemplate;
    
    if (job.userType === 'navneet') {
      // Navneet's original template
      emailTemplate = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body, p, div, a {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #2c3e50;
              margin: 0;
              padding: 0;
            }
            
            .container {
              max-width: 600px;
              padding: 20px;
            }
  
             .greeting {
              margin: 0;
            }
            
            .highlight {
              color: #2c3e50;
              font-weight: bold;
            }
            
            .experience {
              margin: 15px 0;
              padding: 15px;
              background: #f9f9f9;
              border-radius: 4px;
            }
            
            .tech-skills {
              display: inline-block;
              background: #f0f0f0;
              padding: 3px 8px;
              margin: 2px;
              border-radius: 3px;
              font-size: 13px;
              color: #2c3e50;
            }
            
            .links {
              margin: 20px 0;
              text-align: left;
            }
            
            .link-button {
              display: inline-block;
              margin: 5px 12px 5px 0;
              padding: 10px 20px;
              background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
              color: white !important;
              text-decoration: none;
              border-radius: 6px;
              font-size: 14px;
              font-weight: 500;
              letter-spacing: 0.3px;
              border: 2px solid transparent;
              box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
              transition: all 0.3s ease;
            }
            
            .link-button:hover {
              background: linear-gradient(135deg, #3498db 0%, #2c3e50 100%);
              transform: translateY(-1px);
              box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
            }
            
            .link-button:active {
              transform: translateY(1px);
              box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
            }
  
            .link-button.resume {
              background: linear-gradient(135deg, #2ecc71 0%, #27ae60 100%);
            }
            
            .link-button.resume:hover {
              background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%);
            }
  
            .link-button.linkedin {
              background: linear-gradient(135deg, #0077B5 0%, #00A0DC 100%);
            }
            
            .link-button.linkedin:hover {
              background: linear-gradient(135deg, #00A0DC 0%, #0077B5 100%);
            }
  
            .link-button.job {
              background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
            }
            
            .link-button.job:hover {
              background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
            }
            
            hr {
              border: none;
              border-top: 1px solid #eee;
              margin: 20px 0;
            }
            
            ul {
              padding-left: 20px;
              margin: 10px 0;
            }
            
            li {
              margin: 8px 0;
            }
            
            p {
              margin: 15px 0;
            }
            
            @media only screen and (max-width: 600px) {
              .container {
                width: 100% !important;
                padding: 10px !important;
              }
              
              .link-button {
                display: inline-block;
                margin: 5px 10px 5px 0;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <p class="greeting">Hi ${firstName},</p>
            
            <p>I hope you're doing well! I came across the <span class="highlight">${Role}</span> position at <span class="highlight">${Company}</span> and am very interested in the opportunity. I'm currently working as an SDE-2 at Greenlight, focusing on backend development and payment systems.</p>
            
            <p>Here's an overview of my experience:</p>
            
            <div class="experience">
              <ul>
                <li><strong>Greenlight (SDE-2 Backend | Oct 2023 - Present)</strong>
                  <ul>
                    <li>Led development of transaction processing microservices using Java Spring Boot, Node.js, and AWS, handling mission-critical payment operations</li>
                    <li>Architected card payment systems with comprehensive workflows for authorization, settlement, and 3DS authentication</li>
                    <li>Built flexible spend control system and implemented reconciliation processes, improving transaction accuracy by 99.9%</li>
                  </ul>
                </li>
                
                <li><strong>MPL (SDE-1 | Dec 2022 - Sept 2023)</strong>
                  - Led battle limiter feature development and contributed to Brazil market expansion through poker-ops service
                </li>
                
                <li><strong>ULA (SDE-1 | July 2022 - Nov 2022)</strong>
                  - Implemented pickup-point optimization and recommendation engine, reducing logistics costs by 65% and improving adoption by 35%
                </li>
                
                <li><strong>Amazon (SDE Intern | Feb 2022 - June 2022)</strong>
                  - Automated manual processes using Java-mapper-beans and implemented extended log retention using Timber
                </li>
              </ul>
            </div>
            
            <p>Technical skills I frequently use:</p>
            <p>
              <span class="tech-skills">Java Spring Boot</span>
              <span class="tech-skills">Kotlin</span>
              <span class="tech-skills">Node.js</span>
              <span class="tech-skills">PostgreSQL</span>
              <span class="tech-skills">AWS</span>
              <span class="tech-skills">Microservices</span>
              <span class="tech-skills">RESTful APIs</span>
            </p>
            
            <p>A few important points:</p>
            <ul>
              <li>Notice period is 30 days (negotiable)</li>
              <li>Available for immediate interviews</li>
              <li>Strong background in payment systems and scalable architectures</li>
            </ul>
            
            <div class="links">
              <a href="https://drive.google.com/file/d/177azdELnL0AGwqkAHtxiji7fbvkObbbh/view" class="link-button resume">📄 My Resume</a>
              <a href="https://www.linkedin.com/in/navneet-khandelwal-05091a169/" class="link-button linkedin">👤 LinkedIn Profile</a>
              ${Link ? `<a href="${Link}" class="link-button job">🔍 Job Details</a>` : ''}
            </div>
            
            <hr>
            
            <p>I would be delighted to discuss how I can contribute to ${Company}.</p>
            
            <p>Thank you for your time and consideration. Looking forward to hearing from you!<br>
            Best regards,<br>
            Navneet Khandelwal<br>
            +91 9773549557</p>
          </div>
        </body>
        </html>
      `;
    } else if (job.userType === 'other') {
      // Use the custom template provided by the user
      if (!job.customEmailBody) {
        throw new Error('No custom email template provided');
      }
      
      // Get the styling for the email
      const emailStyles = `
        <style>
          body, p, div, a {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #2c3e50;
            margin: 0;
            padding: 0;
          }
          
          .container {
            max-width: 600px;
            padding: 20px;
          }
  
          .greeting {
            margin: 0;
          }
          
          .highlight {
            color: #2c3e50;
            font-weight: bold;
          }
          
          .experience {
            margin: 15px 0;
            padding: 15px;
            background: #f9f9f9;
            border-radius: 4px;
          }
          
          .tech-skills {
            display: inline-block;
            background: #f0f0f0;
            padding: 3px 8px;
            margin: 2px;
            border-radius: 3px;
            font-size: 13px;
            color: #2c3e50;
          }
          
          .links {
            margin: 20px 0;
            text-align: left;
          }
          
          .link-button {
            display: inline-block;
            margin: 5px 12px 5px 0;
            padding: 10px 20px;
            background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
            color: white !important;
            text-decoration: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            letter-spacing: 0.3px;
            border: 2px solid transparent;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            transition: all 0.3s ease;
          }
          
          .link-button:hover {
            background: linear-gradient(135deg, #3498db 0%, #2c3e50 100%);
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
          }
          
          .link-button:active {
            transform: translateY(1px);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
          }
  
          .link-button.resume {
            background: linear-gradient(135deg, #2ecc71 0%, #27ae60 100%);
          }
          
          .link-button.resume:hover {
            background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%);
          }
  
          .link-button.linkedin {
            background: linear-gradient(135deg, #0077B5 0%, #00A0DC 100%);
          }
          
          .link-button.linkedin:hover {
            background: linear-gradient(135deg, #00A0DC 0%, #0077B5 100%);
          }
  
          .link-button.job {
            background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
          }
          
          .link-button.job:hover {
            background: linear-gradient(135deg, #34495e 0%, #2c3e50 100%);
          }
          
          hr {
            border: none;
            border-top: 1px solid #eee;
            margin: 20px 0;
          }
          
          ul {
            padding-left: 20px;
            margin: 10px 0;
          }
          
          li {
            margin: 8px 0;
          }
          
          p {
            margin: 15px 0;
          }
          
          @media only screen and (max-width: 600px) {
            .container {
              width: 100% !important;
              padding: 10px !important;
            }
            
            .link-button {
              display: inline-block;
              margin: 5px 10px 5px 0;
            }
          }
        </style>
      `;
      
      // Ensure the custom template includes <body> tags
      const customBody = job.customEmailBody.trim();
      
      // Create the full HTML email with styles
      emailTemplate = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          ${emailStyles}
        </head>
        ${customBody}
        </html>
      `;
      
      // Process conditional Link statement properly
      const linkRegex = /\$\{Link \? `(.*?)` : ''\}/g;
      emailTemplate = emailTemplate.replace(linkRegex, (match, content) => {
        return Link ? content : '';
      });
      
      // Replace regular template variables
      emailTemplate = emailTemplate
        .replace(/\$\{firstName\}/g, firstName)
        .replace(/\$\{Name\}/g, Name)
        .replace(/\$\{Company\}/g, Company)
        .replace(/\$\{Email\}/g, Email)
        .replace(/\$\{Role\}/g, Role)
        .replace(/\$\{Link\}/g, Link || '');
    } else {
      throw new Error('Invalid user type specified');
    }
    
    const mailOptions = {
      from: `${job.userType === 'navneet' ? 'Navneet Khandelwal' : 'Interview Opportunity Needed'} <${job.email}>`,
      to: Email,
      subject: `Request for an Interview Opportunity - ${Role} at ${Company}`,
      html: emailTemplate
    };
    
    return await transporter.sendMail(mailOptions);
  }

// Send updates to connected clients
function sendToClient(email, data) {
  clients.forEach(client => {
    if (client.email === email) {
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  });
  
  // Also update the job status if it's a progress update
  if (data.type === 'progress') {
    const job = emailJobs.get(email);
    if (job) {
      job.current = data.current;
      job.success = data.success;
      job.failed = data.failed;
    }
  }
}

// Fallback for all other routes to serve React app
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
  });

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});