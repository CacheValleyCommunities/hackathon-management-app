const formData = require('form-data');
const Mailgun = require('mailgun.js');
const mailgun = new Mailgun(formData);

let mg = null;

// Medium-style email template wrapper
const mediumEmailTemplate = (content, eventName = 'Hackathon') => {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff; padding: 40px 20px;">
        <tr>
          <td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 680px; margin: 0 auto;">
              <!-- Header -->
              <tr>
                <td style="padding: 0 0 40px 0; text-align: center;">
                  <h1 style="margin: 0; font-size: 42px; line-height: 1.04; letter-spacing: -0.02em; font-weight: 700; color: #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                    ${eventName}
                  </h1>
                </td>
              </tr>
              <!-- Content -->
              <tr>
                <td style="padding: 0;">
                  <div style="font-size: 21px; line-height: 1.58; letter-spacing: -0.003em; color: #1a1a1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                    ${content}
                  </div>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="padding: 40px 0 0 0; border-top: 1px solid #e0e0e0; margin-top: 40px;">
                  <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #666666; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
                    Best regards,<br>
                    The ${eventName} Team
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
};

const init = () => {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;

  if (!apiKey || !domain) {
    throw new Error('Mailgun configuration missing: MAILGUN_API_KEY and MAILGUN_DOMAIN are required');
  }

  mg = mailgun.client({
    username: 'api',
    key: apiKey,
  });
};

const sendMagicLink = async (email, token, eventName = 'Hackathon') => {
  if (!mg) {
    init();
  }

  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const magicLink = `${appUrl}/auth/verify?token=${token}`;
  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;

  const content = `
    <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Sign in to your account</h2>
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">Click the button below to securely log in to ${eventName}:</p>
    <p style="margin: 0 0 30px 0;">
      <a href="${magicLink}" 
         style="display: inline-block; padding: 12px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 9999px; font-weight: 600; font-size: 16px;">
        Sign In
      </a>
    </p>
    <p style="margin: 0 0 15px 0; font-size: 16px; color: #666666;">Or copy and paste this link into your browser:</p>
    <p style="margin: 0 0 30px 0; word-break: break-all; color: #1a1a1a; font-size: 14px; padding: 12px; background-color: #f5f5f5; border-radius: 4px;">${magicLink}</p>
    <p style="margin: 0; font-size: 14px; color: #666666; line-height: 1.5;">
      This link will expire in 15 minutes. If you didn't request this link, please ignore this email.
    </p>
  `;
  const htmlContent = mediumEmailTemplate(content, eventName);

  const textContent = `${eventName} - Sign In\n\nClick this link to log in:\n${magicLink}\n\nThis link will expire in 15 minutes.\n\nIf you didn't request this link, please ignore this email.`;

  try {
    const messageData = {
      from: fromEmail,
      to: email,
      subject: `Sign in to ${eventName}`,
      html: htmlContent,
      text: textContent,
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Magic link email sent via Mailgun:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending magic link email via Mailgun:', error);
    throw error;
  }
};

const sendTeamRegistrationConfirmation = async (email, teamName, tableName, eventName = 'Hackathon', appUrl = null) => {
  if (!mg) {
    init();
  }

  const baseUrl = appUrl || process.env.APP_URL || 'http://localhost:3000';
  const loginUrl = `${baseUrl}/auth/login`;
  const dashboardUrl = `${baseUrl}/participant`;
  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;

  const content = `
    <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Team Registration Confirmed</h2>
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">Thank you for registering your team for ${eventName}!</p>
    
    <div style="margin: 0 0 30px 0; padding: 20px; background-color: #f5f5f5; border-radius: 4px;">
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Team Name:</strong> ${teamName}</p>
      <p style="margin: 0; color: #1a1a1a;"><strong>Table Location:</strong> ${tableName}</p>
    </div>
    
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">You can now log in to view your team dashboard, check scores, and see the leaderboard.</p>
    
    <p style="margin: 0 0 20px 0;">
      <a href="${dashboardUrl}" 
         style="display: inline-block; padding: 12px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 9999px; font-weight: 600; font-size: 16px;">
        View Team Dashboard
      </a>
    </p>
    
    <p style="margin: 0; font-size: 16px; color: #666666;">Or <a href="${loginUrl}" style="color: #1a1a1a; text-decoration: underline;">log in here</a> to access your account.</p>
  `;
  const htmlContent = mediumEmailTemplate(content, eventName);

  const textContent = `${eventName} - Team Registration Confirmed\n\nThank you for registering your team!\n\nTeam Name: ${teamName}\nTable Location: ${tableName}\n\nLog in to view your dashboard: ${dashboardUrl}\n\nIf you have any questions, please contact the event organizers.`;

  try {
    const messageData = {
      from: fromEmail,
      to: email,
      subject: `${eventName} - Team Registration Confirmed`,
      html: htmlContent,
      text: textContent,
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Team registration confirmation email sent:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending team registration confirmation email:', error);
    throw error;
  }
};

const sendJudgeConfirmation = async (email, name, role, eventName = 'Hackathon', appUrl = null) => {
  if (!mg) {
    init();
  }

  const baseUrl = appUrl || process.env.APP_URL || 'http://localhost:3000';
  const loginUrl = `${baseUrl}/auth/login`;
  const judgeQueueUrl = `${baseUrl}/scores/judge-queue`;
  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;

  const roleDisplay = role === 'admin' ? 'Administrator' : role === 'judge' ? 'Judge' : role.charAt(0).toUpperCase() + role.slice(1);

  const content = `
    <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Welcome, ${name || 'Judge'}!</h2>
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">You have been added as a <strong>${roleDisplay}</strong> for ${eventName}.</p>
    
    <div style="margin: 0 0 30px 0; padding: 20px; background-color: #f5f5f5; border-radius: 4px;">
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Your Role:</strong> ${roleDisplay}</p>
      <p style="margin: 0; color: #1a1a1a;"><strong>Email:</strong> ${email}</p>
    </div>
    
    ${role === 'judge' ? `
    <p style="margin: 0 0 15px 0; color: #1a1a1a; line-height: 1.58;">As a judge, you can:</p>
    <ul style="margin: 0 0 30px 0; padding-left: 24px; color: #1a1a1a; line-height: 1.8;">
      <li>Use the <strong>Judge Queue</strong> to get automatically assigned to teams</li>
      <li>Score teams and provide feedback</li>
      <li>View the leaderboard and results</li>
      <li>Track your judging history</li>
    </ul>
    
    <p style="margin: 0 0 20px 0;">
      <a href="${judgeQueueUrl}" 
         style="display: inline-block; padding: 12px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 9999px; font-weight: 600; font-size: 16px;">
        Start Judging
      </a>
    </p>
    ` : ''}
    
    <p style="margin: 0; font-size: 16px; color: #666666;">Log in to access your dashboard: <a href="${loginUrl}" style="color: #1a1a1a; text-decoration: underline;">${loginUrl}</a></p>
  `;
  const htmlContent = mediumEmailTemplate(content, eventName);

  const textContent = `${eventName} - Welcome ${roleDisplay}!\n\nYou have been added as a ${roleDisplay} for ${eventName}.\n\nYour Role: ${roleDisplay}\nEmail: ${email}\n\n${role === 'judge' ? 'As a judge, you can use the Judge Queue to get automatically assigned to teams, score teams, and view the leaderboard.\n\nStart Judging: ' + judgeQueueUrl + '\n\n' : ''}Log in to access your dashboard: ${loginUrl}\n\nIf you have any questions, please contact the event organizers.`;

  try {
    const messageData = {
      from: fromEmail,
      to: email,
      subject: `${eventName} - Welcome ${roleDisplay}!`,
      html: htmlContent,
      text: textContent,
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Judge confirmation email sent:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending judge confirmation email:', error);
    throw error;
  }
};

const sendGuardianNotification = async (guardianEmail, teamName, tableName, eventName = 'Hackathon', appUrl = null) => {
  if (!mg) {
    init();
  }

  const baseUrl = appUrl || process.env.APP_URL || 'http://localhost:3000';
  const loginUrl = `${baseUrl}/auth/login`;
  const dashboardUrl = `${baseUrl}/participant`;
  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;

  const content = `
    <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Guardian Approval Required</h2>
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">A team registration has been submitted for <strong>${teamName}</strong> and your email address was provided as the guardian contact.</p>
    
    <div style="margin: 0 0 30px 0; padding: 20px; background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px;">
      <p style="margin: 0 0 10px 0; color: #856404; font-weight: 600; font-size: 16px;">Action Required</p>
      <p style="margin: 0; color: #856404; line-height: 1.58;">
        <strong>As the guardian, you are the sole legal entity responsible</strong> for all information entered into the platform. 
        You must complete the team setup and verify all information is accurate.
      </p>
    </div>
    
    <div style="margin: 0 0 30px 0; padding: 20px; background-color: #f5f5f5; border-radius: 4px;">
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Team Name:</strong> ${teamName}</p>
      <p style="margin: 0; color: #1a1a1a;"><strong>Table Location:</strong> ${tableName}</p>
    </div>
    
    <p style="margin: 0 0 15px 0; color: #1a1a1a; line-height: 1.58; font-weight: 600;">Next Steps:</p>
    <ol style="margin: 0 0 30px 0; padding-left: 24px; color: #1a1a1a; line-height: 1.8;">
      <li>Log in to your account using this email address</li>
      <li>Review and complete the team information</li>
      <li>Verify all team member names and project details</li>
      <li>Ensure all content complies with platform policies</li>
    </ol>
    
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">
      By logging in and completing the team setup, you are confirming that you have reviewed and approved all information, 
      and you accept full legal responsibility for the content submitted on behalf of the participant.
    </p>
    
    <p style="margin: 0 0 20px 0;">
      <a href="${dashboardUrl}" 
         style="display: inline-block; padding: 12px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 9999px; font-weight: 600; font-size: 16px;">
        Complete Team Setup
      </a>
    </p>
    
    <p style="margin: 0; font-size: 16px; color: #666666;">Or <a href="${loginUrl}" style="color: #1a1a1a; text-decoration: underline;">log in here</a> to access your account.</p>
    <p style="margin: 20px 0 0 0; font-size: 14px; color: #666666; line-height: 1.5;">
      If you did not approve this registration or have any questions, please contact the event organizers immediately.
    </p>
  `;
  const htmlContent = mediumEmailTemplate(content, eventName);

  const textContent = `${eventName} - Guardian Approval Required\n\nA team registration has been submitted for ${teamName} and your email address was provided as the guardian contact.\n\n⚠️ ACTION REQUIRED\n\nAs the guardian, you are the sole legal entity responsible for all information entered into the platform. You must complete the team setup and verify all information is accurate.\n\nTeam Name: ${teamName}\nTable Location: ${tableName}\n\nNext Steps:\n1. Log in to your account using this email address\n2. Review and complete the team information\n3. Verify all team member names and project details\n4. Ensure all content complies with platform policies\n\nBy logging in and completing the team setup, you are confirming that you have reviewed and approved all information, and you accept full legal responsibility for the content submitted on behalf of the participant.\n\nComplete Team Setup: ${dashboardUrl}\nLog in: ${loginUrl}\n\nIf you did not approve this registration or have any questions, please contact the event organizers immediately.`;

  try {
    const messageData = {
      from: fromEmail,
      to: guardianEmail,
      subject: `${eventName} - Guardian Approval Required for ${teamName}`,
      html: htmlContent,
      text: textContent,
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Guardian notification email sent:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending guardian notification email:', error);
    throw error;
  }
};

const sendDataRemovalRequest = async ({ adminEmail, requesterName, requesterEmail, requesterRelationship, dataSubjectEmail, dataSubjectName, reason, additionalInfo, eventName = 'Hackathon' }) => {
  if (!mg) {
    init();
  }

  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;

  const content = `
    <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Data Removal Request</h2>
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">A data removal request has been submitted for ${eventName}.</p>
    
    <div style="margin: 0 0 30px 0; padding: 20px; background-color: #fef2f2; border-left: 4px solid #dc2626; border-radius: 4px;">
      <h3 style="margin: 0 0 15px 0; color: #991b1b; font-size: 24px; line-height: 1.2; font-weight: 700;">Request Details</h3>
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Requester Name:</strong> ${requesterName}</p>
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Requester Email:</strong> ${requesterEmail}</p>
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Relationship:</strong> ${requesterRelationship}</p>
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Data Subject Email:</strong> ${dataSubjectEmail}</p>
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Data Subject Name:</strong> ${dataSubjectName}</p>
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Reason:</strong> ${reason}</p>
      ${additionalInfo && additionalInfo !== 'None' ? `<p style="margin: 10px 0 0 0; color: #1a1a1a;"><strong>Additional Info:</strong><br><span style="white-space: pre-wrap;">${additionalInfo}</span></p>` : ''}
    </div>
    
    <div style="margin: 0 0 30px 0; padding: 20px; background-color: #fef3c7; border-left: 4px solid #f59e0b; border-radius: 4px;">
      <p style="margin: 0 0 10px 0; color: #92400e; font-weight: 600; font-size: 16px;">Action Required</p>
      <p style="margin: 0; color: #92400e; line-height: 1.58;">
        This request must be processed within 30 days as required by our privacy policy. Please review the request and process the data removal accordingly.
      </p>
    </div>
    
    <p style="margin: 0; font-size: 14px; color: #666666; line-height: 1.5;">
      Request submitted: ${new Date().toLocaleString()}
    </p>
  `;
  const htmlContent = mediumEmailTemplate(content, eventName);

  const textContent = `⚠️ DATA REMOVAL REQUEST\n\nA data removal request has been submitted for ${eventName}.\n\nREQUEST DETAILS:\nRequester Name: ${requesterName}\nRequester Email: ${requesterEmail}\nRelationship: ${requesterRelationship}\nData Subject Email: ${dataSubjectEmail}\nData Subject Name: ${dataSubjectName}\nReason: ${reason}\n${additionalInfo && additionalInfo !== 'None' ? `Additional Info: ${additionalInfo}\n` : ''}\n⚠️ ACTION REQUIRED\n\nThis request must be processed within 30 days as required by our privacy policy. Please review the request and process the data removal accordingly.\n\nRequest submitted: ${new Date().toLocaleString()}`;

  try {
    const messageData = {
      from: fromEmail,
      to: adminEmail,
      subject: `[${eventName}] Data Removal Request - ${dataSubjectEmail}`,
      html: htmlContent,
      text: textContent,
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Data removal request email sent to admin:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending data removal request email:', error);
    throw error;
  }
};

// Send volunteer confirmation email
const sendVolunteerConfirmation = async (email, name, eventName) => {
  if (!mg) {
    init();
  }

  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;

  const subject = `Thank You for Volunteering - ${eventName}`;
  const content = `
    <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Thank You for Your Interest!</h2>
    <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Hi ${name},</p>
    <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Thank you for signing up to volunteer for ${eventName}! We have received your application and are excited about your interest in helping out.</p>
    <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Our team will review your application and get back to you soon. You will receive another email once your application has been reviewed.</p>
    <p style="margin: 0; color: #1a1a1a; line-height: 1.58;">If you have any questions in the meantime, please don't hesitate to reach out.</p>
  `;
  const html = mediumEmailTemplate(content, eventName);
  const text = `Thank you for signing up to volunteer for ${eventName}! We have received your application and will review it shortly. You will receive another email once your application has been reviewed.`;

  try {
    const messageData = {
      from: fromEmail,
      to: email,
      subject,
      html,
      text
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Volunteer confirmation email sent:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending volunteer confirmation email:', error);
    throw error;
  }
};

// Send notification to admin about new volunteer
const sendVolunteerNotificationToAdmin = async (data) => {
  if (!mg) {
    init();
  }

  const { adminEmail, volunteerName, volunteerEmail, volunteerPhone, volunteerCompany, helpJudging, helpLogistics, helpMentor, volunteerDescription, eventName } = data;
  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;

  const helpAreas = [];
  if (helpJudging) helpAreas.push('Judging');
  if (helpLogistics) helpAreas.push('Logistics');
  if (helpMentor) helpAreas.push('Mentoring');

  const subject = `New Volunteer Application - ${eventName}`;
  const content = `
    <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">New Volunteer Application</h2>
    <p style="margin: 0 0 30px 0; color: #1a1a1a; line-height: 1.58;">A new volunteer has submitted an application:</p>
    <div style="margin: 0 0 30px 0; padding: 20px; background-color: #f5f5f5; border-radius: 4px;">
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Name:</strong> ${volunteerName}</p>
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Email:</strong> ${volunteerEmail}</p>
      ${volunteerPhone ? `<p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Phone:</strong> ${volunteerPhone}</p>` : ''}
      ${volunteerCompany ? `<p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Company:</strong> ${volunteerCompany}</p>` : ''}
      <p style="margin: 0 0 10px 0; color: #1a1a1a;"><strong>Wants to help with:</strong> ${helpAreas.join(', ')}</p>
      ${volunteerDescription ? `<p style="margin: 10px 0 0 0; color: #1a1a1a;"><strong>Description:</strong><br><span style="white-space: pre-wrap;">${volunteerDescription}</span></p>` : ''}
    </div>
    <p style="margin: 0;">
      <a href="${process.env.APP_URL || 'http://localhost:3000'}/admin/volunteers" style="display: inline-block; padding: 12px 32px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 9999px; font-weight: 600; font-size: 16px;">Review Application</a>
    </p>
  `;
  const html = mediumEmailTemplate(content, eventName);
  const text = `New volunteer application:\n\nName: ${volunteerName}\nEmail: ${volunteerEmail}\n${volunteerPhone ? `Phone: ${volunteerPhone}\n` : ''}${volunteerCompany ? `Company: ${volunteerCompany}\n` : ''}Wants to help with: ${helpAreas.join(', ')}${volunteerDescription ? `\n\nDescription:\n${volunteerDescription}` : ''}\n\nReview at: ${process.env.APP_URL || 'http://localhost:3000'}/admin/volunteers`;

  try {
    const messageData = {
      from: fromEmail,
      to: adminEmail,
      subject,
      html,
      text
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Volunteer notification email sent to admin:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending volunteer notification to admin:', error);
    throw error;
  }
};

// Send volunteer approval/denial email
const sendVolunteerStatusUpdate = async (email, name, status, eventName) => {
  if (!mg) {
    init();
  }

  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;
  const isApproved = status === 'approved';
  const subject = `Volunteer Application ${isApproved ? 'Approved' : 'Update'} - ${eventName}`;

  let html, text;
  if (isApproved) {
    const content = `
      <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Your Volunteer Application Has Been Approved!</h2>
      <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Hi ${name},</p>
      <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Great news! Your volunteer application for ${eventName} has been approved. We're thrilled to have you on board!</p>
      <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Our team will be in touch with you soon with more details about how you can help and what to expect.</p>
      <p style="margin: 0; color: #1a1a1a; line-height: 1.58;">Thank you for your willingness to contribute to making ${eventName} a success!</p>
    `;
    html = mediumEmailTemplate(content, eventName);
    text = `Your volunteer application for ${eventName} has been approved! We're thrilled to have you on board. Our team will be in touch with you soon with more details.`;
  } else {
    const content = `
      <h2 style="margin: 0 0 20px 0; font-size: 32px; line-height: 1.12; letter-spacing: -0.018em; font-weight: 700; color: #1a1a1a;">Volunteer Application Update</h2>
      <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Hi ${name},</p>
      <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Thank you for your interest in volunteering for ${eventName}.</p>
      <p style="margin: 0 0 20px 0; color: #1a1a1a; line-height: 1.58;">Unfortunately, we are unable to accommodate your volunteer application at this time. We appreciate your willingness to help and encourage you to apply again in the future.</p>
      <p style="margin: 0; color: #1a1a1a; line-height: 1.58;">If you have any questions, please don't hesitate to reach out.</p>
    `;
    html = mediumEmailTemplate(content, eventName);
    text = `Thank you for your interest in volunteering for ${eventName}. Unfortunately, we are unable to accommodate your volunteer application at this time. We appreciate your willingness to help and encourage you to apply again in the future.`;
  }

  try {
    const messageData = {
      from: fromEmail,
      to: email,
      subject,
      html,
      text
    };

    const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
    console.log('Volunteer status update email sent:', response.id);
    return response;
  } catch (error) {
    console.error('Error sending volunteer status update email:', error);
    throw error;
  }
};

// Send newsletter to multiple recipients
const sendNewsletter = async (recipients, subject, markdownContent, eventName = 'Hackathon') => {
  if (!mg) {
    init();
  }

  const { marked } = require('marked');
  const fromEmail = process.env.EMAIL_FROM || `noreply@${process.env.MAILGUN_DOMAIN}`;
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  // Configure marked for safe rendering
  marked.setOptions({
    breaks: true,
    gfm: true
  });

  // Helper function to parse name into first and last
  const parseName = (name) => {
    if (!name) {
      return { first: '', last: '' };
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
      return { first: parts[0], last: '' };
    }
    const first = parts[0];
    const last = parts.slice(1).join(' ');
    return { first, last };
  };

  // Helper function to replace personalization tokens
  const personalizeContent = (content, recipient) => {
    const { first, last } = parseName(recipient.name);
    const email = recipient.email || '';

    return content
      .replace(/\{\{first\}\}/g, first)
      .replace(/\{\{last\}\}/g, last)
      .replace(/\{\{email\}\}/g, email)
      .replace(/\{\{url\}\}/g, appUrl);
  };

  // Helper function to escape HTML for safe replacement in HTML content
  const escapeHtml = (text) => {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };

  // Helper function to personalize HTML content (after markdown is converted)
  const personalizeHtml = (html, recipient) => {
    const { first, last } = parseName(recipient.name);
    const email = recipient.email || '';

    // Escape values for HTML
    const firstEscaped = escapeHtml(first);
    const lastEscaped = escapeHtml(last);
    const emailEscaped = escapeHtml(email);

    return html
      .replace(/\{\{first\}\}/g, firstEscaped)
      .replace(/\{\{last\}\}/g, lastEscaped)
      .replace(/\{\{email\}\}/g, emailEscaped)
      .replace(/\{\{url\}\}/g, appUrl);
  };

  const results = [];
  const errors = [];

  // Send to each recipient with personalized content
  for (const recipient of recipients) {
    try {
      // Personalize the markdown content before converting to HTML
      const personalizedMarkdown = personalizeContent(markdownContent, recipient);

      // Convert personalized markdown to HTML
      let htmlContent = marked.parse(personalizedMarkdown);

      // Also replace tokens in the HTML (in case markdown conversion didn't catch them)
      htmlContent = personalizeHtml(htmlContent, recipient);

      // Create the full email template with the personalized rendered markdown
      const fullHtmlContent = mediumEmailTemplate(htmlContent, eventName);

      // Personalize plain text version
      const personalizedText = personalizeContent(personalizedMarkdown, recipient);
      const textContent = personalizedText
        .replace(/#{1,6}\s+/g, '') // Remove markdown headers
        .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold
        .replace(/\*(.*?)\*/g, '$1') // Remove italic
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Remove links, keep text
        .replace(/`([^`]+)`/g, '$1') // Remove code formatting
        .trim();

      // Personalize subject line
      const personalizedSubject = personalizeContent(subject, recipient);

      const messageData = {
        from: fromEmail,
        to: recipient.email,
        subject: personalizedSubject,
        html: fullHtmlContent,
        text: textContent,
      };

      const response = await mg.messages.create(process.env.MAILGUN_DOMAIN, messageData);
      results.push({ email: recipient.email, success: true, id: response.id });
    } catch (error) {
      console.error(`Error sending newsletter to ${recipient.email}:`, error);
      errors.push({ email: recipient.email, error: error.message });
    }
  }

  return {
    sent: results.length,
    failed: errors.length,
    total: recipients.length,
    results,
    errors
  };
};

module.exports = {
  init,
  sendMagicLink,
  sendTeamRegistrationConfirmation,
  sendJudgeConfirmation,
  sendGuardianNotification,
  sendDataRemovalRequest,
  sendVolunteerConfirmation,
  sendVolunteerNotificationToAdmin,
  sendVolunteerStatusUpdate,
  sendNewsletter
};

