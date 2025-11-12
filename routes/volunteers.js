const express = require('express');
const router = express.Router();
const db = require('../db/database');
const emailService = require('../services/email');
const { checkAndReturnError } = require('../middleware/validation');

// GET volunteer signup form
router.get('/signup', async (req, res) => {
  try {
    const eventSettings = await db.getEventSettings();
    res.render('volunteers/signup', {
      title: 'Volunteer Signup',
      layout: 'main',
      eventSettings,
      error: null,
      success: null
    });
  } catch (error) {
    console.error('Error loading volunteer signup form:', error);
    res.render('volunteers/signup', {
      title: 'Volunteer Signup',
      layout: 'main',
      eventSettings: { event_name: 'Hackathon' },
      error: 'An error occurred loading the form.',
      success: null
    });
  }
});

// POST volunteer signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, company, help_judging, help_logistics, help_mentor, description } = req.body;
    const eventSettings = await db.getEventSettings();

    // Validation
    if (!name || !email || !email.includes('@')) {
      return res.render('volunteers/signup', {
        title: 'Volunteer Signup',
        layout: 'main',
        eventSettings,
        error: 'Please provide your name and a valid email address.',
        success: null
      });
    }

    // At least one help option must be selected
    if (!help_judging && !help_logistics && !help_mentor) {
      return res.render('volunteers/signup', {
        title: 'Volunteer Signup',
        layout: 'main',
        eventSettings,
        error: 'Please select at least one way you would like to help.',
        success: null
      });
    }

    // Check for profanity in name
    const nameError = await checkAndReturnError(name, 'Name');
    if (nameError) {
      return res.render('volunteers/signup', {
        title: 'Volunteer Signup',
        layout: 'main',
        eventSettings,
        error: nameError,
        success: null
      });
    }

    // Check if email already exists
    const existingVolunteers = await db.getVolunteers();
    const emailExists = existingVolunteers.some(v => v.email.toLowerCase() === email.toLowerCase().trim());
    
    if (emailExists) {
      return res.render('volunteers/signup', {
        title: 'Volunteer Signup',
        layout: 'main',
        eventSettings,
        error: 'A volunteer application with this email address already exists.',
        success: null
      });
    }

    // Check for profanity in description if provided
    if (description) {
      const descriptionError = await checkAndReturnError(description, 'Description');
      if (descriptionError) {
        return res.render('volunteers/signup', {
          title: 'Volunteer Signup',
          layout: 'main',
          eventSettings,
          error: descriptionError,
          success: null
        });
      }
    }

    // Create volunteer
    const volunteer = await db.createVolunteer({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone ? phone.trim() : null,
      company: company ? company.trim() : null,
      help_judging: help_judging === '1' || help_judging === true,
      help_logistics: help_logistics === '1' || help_logistics === true,
      help_mentor: help_mentor === '1' || help_mentor === true,
      description: description ? description.trim() : null
    });

    // Send confirmation email to volunteer
    try {
      await emailService.sendVolunteerConfirmation(
        volunteer.email,
        volunteer.name,
        eventSettings.event_name || 'Hackathon'
      );
    } catch (emailError) {
      console.error('Error sending volunteer confirmation email:', emailError);
      // Continue even if email fails
    }

    // Send notification email to admin
    try {
      const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || process.env.EMAIL_FROM || 'admin@example.com';
      await emailService.sendVolunteerNotificationToAdmin({
        adminEmail,
        volunteerName: volunteer.name,
        volunteerEmail: volunteer.email,
        volunteerPhone: volunteer.phone,
        volunteerCompany: volunteer.company,
        helpJudging: volunteer.help_judging,
        helpLogistics: volunteer.help_logistics,
        helpMentor: volunteer.help_mentor,
        volunteerDescription: volunteer.description,
        eventName: eventSettings.event_name || 'Hackathon'
      });
    } catch (emailError) {
      console.error('Error sending admin notification email:', emailError);
      // Continue even if email fails
    }

    res.render('volunteers/signup', {
      title: 'Volunteer Signup',
      layout: 'main',
      eventSettings,
      error: null,
      success: 'Thank you for your interest in volunteering! We have received your application and will review it shortly. You will receive an email confirmation and another email once your application has been reviewed.'
    });
  } catch (error) {
    console.error('Error processing volunteer signup:', error);
    const eventSettings = await db.getEventSettings().catch(() => ({ event_name: 'Hackathon' }));
    res.render('volunteers/signup', {
      title: 'Volunteer Signup',
      layout: 'main',
      eventSettings,
      error: 'An error occurred processing your application. Please try again or contact us directly.',
      success: null
    });
  }
});

module.exports = router;

