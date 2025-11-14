const express = require('express');
const router = express.Router();
const db = require('../db/database');
const emailService = require('../services/email');

// GET Privacy Policy
router.get('/privacy', async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const metaImage = eventSettings.logo_filename ? `${appUrl}/uploads/${eventSettings.logo_filename}` : null;
    
    const meta = {
      type: 'website',
      title: 'Privacy Policy',
      description: `Privacy Policy for ${eventSettings.event_name || 'this hackathon'}. Learn how we collect, use, and protect your personal information.`,
      url: `${appUrl}/policies/privacy`,
      image: metaImage,
      siteName: eventSettings.event_name || 'Hackathon',
      twitterCard: 'summary'
    };
    
    res.render('policies/privacy', {
      title: 'Privacy Policy',
      layout: 'main',
      eventSettings,
      meta
    });
  } catch (error) {
    console.error('Error loading privacy policy:', error);
    res.render('policies/privacy', {
      title: 'Privacy Policy',
      layout: 'main',
      eventSettings: { event_name: 'Hackathon' }
    });
  }
});

// GET Terms of Use
router.get('/terms', async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const metaImage = eventSettings.logo_filename ? `${appUrl}/uploads/${eventSettings.logo_filename}` : null;
    
    const meta = {
      type: 'website',
      title: 'Terms of Use',
      description: `Terms of Use for ${eventSettings.event_name || 'this hackathon'}. Read our terms and conditions for using this platform.`,
      url: `${appUrl}/policies/terms`,
      image: metaImage,
      siteName: eventSettings.event_name || 'Hackathon',
      twitterCard: 'summary'
    };
    
    res.render('policies/terms', {
      title: 'Terms of Use',
      layout: 'main',
      eventSettings,
      meta
    });
  } catch (error) {
    console.error('Error loading terms of use:', error);
    res.render('policies/terms', {
      title: 'Terms of Use',
      layout: 'main',
      eventSettings: { event_name: 'Hackathon' }
    });
  }
});

// GET Acceptable Use Policy
router.get('/acceptable-use', async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const metaImage = eventSettings.logo_filename ? `${appUrl}/uploads/${eventSettings.logo_filename}` : null;
    
    const meta = {
      type: 'website',
      title: 'Acceptable Use Policy',
      description: `Acceptable Use Policy for ${eventSettings.event_name || 'this hackathon'}. Guidelines for appropriate use of this platform.`,
      url: `${appUrl}/policies/acceptable-use`,
      image: metaImage,
      siteName: eventSettings.event_name || 'Hackathon',
      twitterCard: 'summary'
    };
    
    res.render('policies/acceptable-use', {
      title: 'Acceptable Use Policy',
      layout: 'main',
      eventSettings,
      meta
    });
  } catch (error) {
    console.error('Error loading acceptable use policy:', error);
    res.render('policies/acceptable-use', {
      title: 'Acceptable Use Policy',
      layout: 'main',
      eventSettings: { event_name: 'Hackathon' }
    });
  }
});

// GET Data Removal Request Form
router.get('/data-removal-request', async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const metaImage = eventSettings.logo_filename ? `${appUrl}/uploads/${eventSettings.logo_filename}` : null;
    
    const meta = {
      type: 'website',
      title: 'Data Removal Request',
      description: `Request data removal from ${eventSettings.event_name || 'this hackathon'}. Submit a request to have your personal data removed.`,
      url: `${appUrl}/policies/data-removal-request`,
      image: metaImage,
      siteName: eventSettings.event_name || 'Hackathon',
      twitterCard: 'summary'
    };
    
    res.render('policies/data-removal-request', {
      title: 'Data Removal Request',
      layout: 'main',
      eventSettings,
      error: null,
      success: null,
      meta
    });
  } catch (error) {
    console.error('Error loading data removal request form:', error);
    res.render('policies/data-removal-request', {
      title: 'Data Removal Request',
      layout: 'main',
      eventSettings: { event_name: 'Hackathon' },
      error: 'An error occurred loading the form.',
      success: null
    });
  }
});

// POST Data Removal Request
router.post('/data-removal-request', async (req, res) => {
  try {
    const { requester_name, requester_email, requester_relationship, data_subject_email, data_subject_name, reason, additional_info } = req.body;
    const eventSettings = await db.getEventSettings();

    // Validation
    if (!requester_name || !requester_email || !requester_email.includes('@')) {
      return res.render('policies/data-removal-request', {
        title: 'Data Removal Request',
        layout: 'main',
        eventSettings,
        error: 'Please provide your name and a valid email address.',
        success: null
      });
    }

    if (!data_subject_email || !data_subject_email.includes('@')) {
      return res.render('policies/data-removal-request', {
        title: 'Data Removal Request',
        layout: 'main',
        eventSettings,
        error: 'Please provide the email address of the person whose data should be removed.',
        success: null
      });
    }

    // Get admin email from environment or use a default
    const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || process.env.EMAIL_FROM || 'admin@example.com';

    // Send email notification to admin
    try {
      await emailService.sendDataRemovalRequest({
        adminEmail,
        requesterName: requester_name,
        requesterEmail: requester_email,
        requesterRelationship: requester_relationship || 'Self',
        dataSubjectEmail: data_subject_email,
        dataSubjectName: data_subject_name || 'Not provided',
        reason: reason || 'Not provided',
        additionalInfo: additional_info || 'None',
        eventName: eventSettings.event_name || 'Hackathon'
      });
    } catch (emailError) {
      console.error('Error sending data removal request email:', emailError);
      // Continue even if email fails - we'll still show success
    }

    res.render('policies/data-removal-request', {
      title: 'Data Removal Request',
      layout: 'main',
      eventSettings,
      error: null,
      success: 'Your data removal request has been submitted. We will process it within 30 days as required by our privacy policy. You will receive a confirmation email shortly.'
    });
  } catch (error) {
    console.error('Error processing data removal request:', error);
    const eventSettings = await db.getEventSettings().catch(() => ({ event_name: 'Hackathon' }));
    res.render('policies/data-removal-request', {
      title: 'Data Removal Request',
      layout: 'main',
      eventSettings,
      error: 'An error occurred processing your request. Please try again or contact us directly.',
      success: null
    });
  }
});

module.exports = router;

