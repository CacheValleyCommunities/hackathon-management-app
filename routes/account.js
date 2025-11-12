const express = require('express');
const router = express.Router();
const db = require('../db/database');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

// Middleware to require authentication
const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/auth/login');
  }
  next();
};

// GET account settings page
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserByEmail(req.session.user.email);
    if (!user) {
      return res.redirect('/auth/login');
    }

    const error = req.query.error || null;
    const success = req.query.success || null;

    res.render('account/settings', {
      title: 'Account Settings',
      user: {
        email: user.email,
        name: user.name || '',
        email_preferences: user.email_preferences === 1
      },
      error: error === 'preferences_updated' ? null : error === 'update_failed' ? 'Failed to update preferences' : error === 'confirmation_required' ? 'Please type DELETE to confirm account deletion' : error === 'admin_cannot_delete' ? 'Admin accounts cannot be deleted through this interface' : error === 'delete_failed' ? 'Failed to delete account' : null,
      success: success === 'preferences_updated' ? 'Email preferences updated successfully' : null
    });
  } catch (error) {
    console.error('Error loading account settings:', error);
    res.render('account/settings', {
      title: 'Account Settings',
      user: { email: req.session.user.email, name: '', email_preferences: false },
      error: 'An error occurred loading your account settings.',
      success: null
    });
  }
});

// POST update email preferences
router.post('/settings/email-preferences', requireAuth, async (req, res) => {
  try {
    const { email_preferences } = req.body;
    const email = req.session.user.email;

    await db.updateUser(email, {
      email_preferences: email_preferences === '1' || email_preferences === true
    });

    res.redirect('/account/settings?success=preferences_updated');
  } catch (error) {
    console.error('Error updating email preferences:', error);
    res.redirect('/account/settings?error=update_failed');
  }
});

// GET export user data as ZIP
router.get('/export', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    const exportData = await db.getUserDataForExport(email);

    // Sanitize email for filename
    const safeEmail = email.replace(/[^a-zA-Z0-9]/g, '_');
    const timestamp = Date.now();
    const zipFilename = `user-data-${safeEmail}-${timestamp}.zip`;

    // Set headers for ZIP download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    // Create ZIP archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Handle archive errors
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      }
    });

    // Pipe archive to response
    archive.pipe(res);

    // Add README file explaining the contents
    const readmeContent = `# Your Data Export

This ZIP file contains all your personal data from the platform.

## Contents

- **data.json** - All your account information, team data, and scores in JSON format
- **images/** - All images associated with your account
  - **banner.*** - Your team's banner image (if applicable)
  - **logo.*** - Your team's logo image (if applicable)
  - **screenshots/** - All project screenshots (if applicable)

## Data Structure

The data.json file contains:
- User account information
- Team registration data (if you're a participant)
- All scores you've submitted (if you're a judge)
- Policy acceptance records
- Email preferences

## Export Date

${new Date().toISOString()}

For questions about this data export, please contact the event administrators.
`;
    archive.append(readmeContent, { name: 'README.txt' });

    // Add JSON data file
    archive.append(JSON.stringify(exportData, null, 2), { name: 'data.json' });

    // Add team images if user has a team
    if (exportData.team) {
      const uploadsDir = path.join(__dirname, '../public/uploads/screenshots');

      // Add banner image if exists
      if (exportData.team.banner_image) {
        const bannerPath = path.join(uploadsDir, exportData.team.banner_image);
        if (fs.existsSync(bannerPath)) {
          archive.file(bannerPath, { name: `images/banner.${path.extname(exportData.team.banner_image)}` });
        }
      }

      // Add logo image if exists
      if (exportData.team.logo_image) {
        const logoPath = path.join(uploadsDir, exportData.team.logo_image);
        if (fs.existsSync(logoPath)) {
          archive.file(logoPath, { name: `images/logo.${path.extname(exportData.team.logo_image)}` });
        }
      }

      // Add screenshots if they exist
      if (exportData.team.screenshots && exportData.team.screenshots.length > 0) {
        exportData.team.screenshots.forEach((screenshot, index) => {
          const screenshotPath = path.join(uploadsDir, screenshot.filename);
          if (fs.existsSync(screenshotPath)) {
            const ext = path.extname(screenshot.filename);
            const originalName = screenshot.original_filename || `screenshot-${index + 1}${ext}`;
            archive.file(screenshotPath, { name: `images/screenshots/${originalName}` });
          }
        });
      }
    }

    // Finalize the archive
    await archive.finalize();
  } catch (error) {
    console.error('Error exporting user data:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export user data' });
    }
  }
});

// POST delete account
router.post('/delete', requireAuth, async (req, res) => {
  try {
    const email = req.session.user.email;
    
    // Verify user wants to delete
    const { confirm } = req.body;
    if (confirm !== 'DELETE') {
      return res.redirect('/account/settings?error=confirmation_required');
    }

    await db.deleteUserAccount(email);

    // Clear session and cookies
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
      }
      res.clearCookie('token');
      res.clearCookie('connect.sid');
      res.redirect('/auth/login?message=account_deleted');
    });
  } catch (error) {
    console.error('Error deleting account:', error);
    if (error.message === 'Admin accounts cannot be deleted through this interface') {
      return res.redirect('/account/settings?error=admin_cannot_delete');
    }
    res.redirect('/account/settings?error=delete_failed');
  }
});

module.exports = router;

