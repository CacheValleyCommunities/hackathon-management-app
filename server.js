require('dotenv').config();
const express = require('express');
const exphbs = require('express-handlebars');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./db/database');
const authRoutes = require('./routes/auth');
const scoreRoutes = require('./routes/scores');
const indexRoutes = require('./routes/index');
const registerRoutes = require('./routes/register');
const adminRoutes = require('./routes/admin');
const participantRoutes = require('./routes/participant');
const projectsRoutes = require('./routes/projects');
const policiesRoutes = require('./routes/policies');
const accountRoutes = require('./routes/account');
const volunteersRoutes = require('./routes/volunteers');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-jwt-secret';

// Initialize database
(async () => {
    try {
        await db.init();
    } catch (error) {
        console.error('Initialization error:', error);
        console.error('Please check your configuration files (.env)');
    }
})();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: './db'
    }),
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Handlebars configuration
const helpers = require('./views/helpers');
app.engine('hbs', exphbs.engine({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, 'views/layouts'),
    partialsDir: path.join(__dirname, 'views/partials'),
    helpers: helpers
}));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// JWT Authentication Middleware
app.use((req, res, next) => {
    const token = req.cookies?.token;

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = decoded;

            // Also set session for backward compatibility
            if (!req.session.user) {
                req.session.user = decoded;
            }
        } catch (err) {
            // Invalid token, clear it
            res.clearCookie('token');
            req.user = null;
        }
    } else {
        req.user = null;
    }

    next();
});

// Middleware to make user, event settings, and current year available to all views
app.use(async (req, res, next) => {
    res.locals.user = req.user || req.session.user || null;
    res.locals.currentRound = req.session.currentRound || 1;
    res.locals.currentYear = new Date().getFullYear();

    // Base URL for meta tags
    const protocol = req.protocol;
    const host = req.get('host');
    res.locals.baseUrl = process.env.APP_URL || `${protocol}://${host}`;

    try {
        const eventSettings = await db.getEventSettings();
        res.locals.eventSettings = eventSettings;
    } catch (error) {
        console.error('Error loading event settings:', error);
        res.locals.eventSettings = {
            event_name: 'Hackathon',
            start_date: null,
            end_date: null,
            divisions: [],
            logo_filename: null
        };
    }
    next();
});

// Routes
app.use('/', indexRoutes);
app.use('/auth', authRoutes);
app.use('/scores', scoreRoutes);
app.use('/register', registerRoutes);
app.use('/admin', adminRoutes);
app.use('/participant', participantRoutes);
app.use('/projects', projectsRoutes);
app.use('/policies', policiesRoutes);
app.use('/account', accountRoutes);
app.use('/volunteers', volunteersRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        message: err.message || 'Something went wrong!',
        error: process.env.NODE_ENV === 'development' ? err : {}
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', {
        message: 'Page not found'
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

