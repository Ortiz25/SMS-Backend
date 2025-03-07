// routes/communicationRoutes.js
import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';


const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);


// Get communication statistics
router.get('/stats', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    // Get pending messages count
    const pendingMessagesQuery = `
      SELECT COUNT(*) as count
      FROM communication_logs
      WHERE status = 'pending'
    `;
    
    // Get unread notifications count
    const unreadNotificationsQuery = `
      SELECT COUNT(*) as count
      FROM communication_logs
      WHERE status = 'delivered' 
      AND delivery_time > NOW() - INTERVAL '7 days'
      AND recipient_type = 'individual'
      AND recipient_group_id IS NULL
    `;
    
    // Get active announcements count
    const activeAnnouncementsQuery = `
      SELECT COUNT(*) as count
      FROM communication_logs
      WHERE communication_type = 'system'
      AND status = 'sent'
      AND delivery_time > NOW() - INTERVAL '30 days'
      AND recipient_type IN ('all', 'class', 'department')
    `;
    
    const pendingMessages = await pool.query(pendingMessagesQuery);
    const unreadNotifications = await pool.query(unreadNotificationsQuery);
    const activeAnnouncements = await pool.query(activeAnnouncementsQuery);
    
    res.status(200).json({
      pendingMessages: parseInt(pendingMessages.rows[0].count),
      unreadNotifications: parseInt(unreadNotifications.rows[0].count),
      activeAnnouncements: parseInt(activeAnnouncements.rows[0].count),
    });
  } catch (error) {
    console.error('Error fetching communication stats:', error);
    res.status(500).json({ message: 'Server error while fetching communication statistics' });
  }
});

// Get announcements
router.get('/announcements', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const query = `
      SELECT 
        cl.id,
        u.username as sender_name,
        CASE 
          WHEN cl.recipient_type = 'all' THEN 'All Users'
          WHEN cl.recipient_type = 'class' THEN (SELECT name FROM classes WHERE id = cl.recipient_group_id)
          WHEN cl.recipient_type = 'department' THEN (SELECT name FROM departments WHERE id = cl.recipient_group_id)
          ELSE cl.recipient_type
        END as audience,
        cl.message,
        cl.created_at,
        cl.status,
        cl.delivery_time
      FROM 
        communication_logs cl
      JOIN 
        users u ON cl.sender_id = u.id
      WHERE 
        cl.communication_type = 'system'
      ORDER BY 
        cl.created_at DESC
      LIMIT 50
    `;
    
    const result = await pool.query(query);
    
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ message: 'Server error while fetching announcements' });
  }
});

// Create new announcement
router.post('/announcements', 
    authorizeRoles('admin', 'teacher', 'staff'),
    [
      body('message').notEmpty().withMessage('Message is required'),
      body('recipientType').isIn(['all', 'class', 'department']).withMessage('Valid recipient type is required'),
      body('recipientGroupId')
        .if(body('recipientType').not().equals('all'))
        .isInt().withMessage('Valid recipient group ID is required for class or department')
    ],
    async (req, res) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
    
      const { message, recipientType, recipientGroupId } = req.body;
      const senderId = req.user.id;
    
      try {
        // Convert recipientGroupId to null if it's an empty string or not provided
        const groupId = recipientGroupId && recipientGroupId !== '' ? parseInt(recipientGroupId, 10) : null;
        
        const query = `
          INSERT INTO communication_logs
            (sender_id, recipient_type, recipient_group_id, message, communication_type, status, delivery_time)
          VALUES
            ($1, $2, $3, $4, 'system', 'sent', NOW())
          RETURNING *
        `;
        
        const values = [senderId, recipientType, groupId, message];
        const result = await pool.query(query, values);
        
        res.status(201).json(result.rows[0]);
      } catch (error) {
        console.error('Error creating announcement:', error);
        res.status(500).json({ message: 'Server error while creating announcement' });
      }
    }
  );
// Get emails
router.get('/emails', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const query = `
      SELECT 
        cl.id,
        u.username as sender_name,
        cl.recipient_phone as recipient_email,
        cl.message,
        cl.created_at,
        cl.status,
        cl.delivery_time
      FROM 
        communication_logs cl
      JOIN 
        users u ON cl.sender_id = u.id
      WHERE 
        cl.communication_type = 'email'
      ORDER BY 
        cl.created_at DESC
      LIMIT 50
    `;
    
    const result = await pool.query(query);
    
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ message: 'Server error while fetching emails' });
  }
});

// Send email
router.post('/emails',
  authorizeRoles('admin', 'teacher', 'staff'),
  [
    body('message').notEmpty().withMessage('Message is required'),
    body('subject').notEmpty().withMessage('Subject is required'),
    body('recipientType').isIn(['individual', 'all', 'class', 'department']).withMessage('Valid recipient type is required'),
    body('recipientEmails')
      .if(body('recipientType').equals('individual'))
      .isArray().withMessage('Recipient emails are required for individual recipients'),
    body('recipientGroupId')
      .if(body('recipientType').not().equals('individual').not().equals('all'))
      .isInt().withMessage('Valid recipient group ID is required for class or department')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { message, recipientType, recipientEmails, recipientGroupId = null, subject } = req.body;
    const senderId = req.user.id;
    
    try {
      // Start a database transaction
      await pool.query('BEGIN');
      
      // Handle different recipient types
      if (recipientType === 'individual' && Array.isArray(recipientEmails)) {
        // Send to multiple individual recipients
        for (const email of recipientEmails) {
          await pool.query(`
            INSERT INTO communication_logs
              (sender_id, recipient_type, recipient_phone, message, communication_type, status)
            VALUES
              ($1, 'individual', $2, $3, 'email', 'pending')
          `, [senderId, email, `Subject: ${subject}\n\n${message}`]);
        }
      } else {
        // Send to a group (class, department, all)
        await pool.query(`
          INSERT INTO communication_logs
            (sender_id, recipient_type, recipient_group_id, message, communication_type, status)
          VALUES
            ($1, $2, $3, $4, 'email', 'pending')
        `, [senderId, recipientType, recipientGroupId, `Subject: ${subject}\n\n${message}`]);
      }
      
      // Commit the transaction
      await pool.query('COMMIT');
      
      // In a real application, you would queue these emails for sending here
      // ...

      res.status(200).json({ message: 'Emails queued for sending' });
    } catch (error) {
      // Rollback on error
      await pool.query('ROLLBACK');
      console.error('Error sending email:', error);
      res.status(500).json({ message: 'Server error while sending email' });
    }
  }
);

// Get SMS messages
router.get('/sms', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const query = `
      SELECT 
        cl.id,
        u.username as sender_name,
        cl.recipient_phone,
        cl.message,
        cl.created_at,
        cl.status,
        cl.delivery_time,
        cl.cost
      FROM 
        communication_logs cl
      JOIN 
        users u ON cl.sender_id = u.id
      WHERE 
        cl.communication_type = 'sms'
      ORDER BY 
        cl.created_at DESC
      LIMIT 50
    `;
    
    const result = await pool.query(query);
    
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching SMS messages:', error);
    res.status(500).json({ message: 'Server error while fetching SMS messages' });
  }
});

// Send SMS
router.post('/sms',
  authorizeRoles('admin', 'teacher', 'staff'),
  [
    body('message').notEmpty().withMessage('Message is required'),
    body('recipientType').isIn(['individual', 'all', 'class', 'department']).withMessage('Valid recipient type is required'),
    body('recipientPhones')
      .if(body('recipientType').equals('individual'))
      .isArray().withMessage('Recipient phones are required for individual recipients'),
    body('recipientGroupId')
      .if(body('recipientType').not().equals('individual').not().equals('all'))
      .isInt().withMessage('Valid recipient group ID is required for class or department'),
    body('templateId').optional().isInt().withMessage('Template ID must be an integer')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { message, recipientType, recipientPhones, recipientGroupId = null, templateId = null } = req.body;
    const senderId = req.user.id;
    
    try {
      // Start a database transaction
      await pool.query('BEGIN');

      // Get message cost (in a real app, integrate with SMS provider API)
      const estimatedCost = 1.0; // Example cost per SMS
      
      // Handle different recipient types
      if (recipientType === 'individual' && Array.isArray(recipientPhones)) {
        // Send to multiple individual recipients
        for (const phone of recipientPhones) {
          await pool.query(`
            INSERT INTO communication_logs
              (sender_id, recipient_type, recipient_phone, message, communication_type, template_id, cost, status)
            VALUES
              ($1, 'individual', $2, $3, 'sms', $4, $5, 'pending')
          `, [senderId, phone, message, templateId, estimatedCost]);
        }
      } else {
        // For group messages (class, department, all)
        let recipientQuery;
        let recipientValues = [];
        
        if (recipientType === 'class') {
          recipientQuery = `
            SELECT p.phone_primary as phone
            FROM students s
            JOIN student_parent_relationships spr ON s.id = spr.student_id
            JOIN parents p ON spr.parent_id = p.id
            WHERE s.current_class = (SELECT level FROM classes WHERE id = $1)
            AND s.stream = (SELECT stream FROM classes WHERE id = $1)
            AND spr.is_primary_contact = true
          `;
          recipientValues = [recipientGroupId];
        } else if (recipientType === 'department') {
          recipientQuery = `
            SELECT t.phone_primary as phone
            FROM teachers t
            WHERE t.department = (SELECT name FROM departments WHERE id = $1)
          `;
          recipientValues = [recipientGroupId];
        } else if (recipientType === 'all') {
          recipientQuery = `
            SELECT phone_primary as phone FROM teachers
            UNION
            SELECT phone_primary as phone FROM parents WHERE is_primary_contact = true
          `;
        }
        
        // Get all recipient phone numbers
        const recipients = await pool.query(recipientQuery, recipientValues);
        
        // Log each message
        for (const recipient of recipients.rows) {
          await pool.query(`
            INSERT INTO communication_logs
              (sender_id, recipient_type, recipient_phone, message, communication_type, template_id, recipient_group_id, cost, status)
            VALUES
              ($1, $2, $3, $4, 'sms', $5, $6, $7, 'pending')
          `, [senderId, recipientType, recipient.phone, message, templateId, recipientGroupId, estimatedCost]);
        }
      }
      
      // Commit the transaction
      await pool.query('COMMIT');
      
      // In a real application, you would queue these SMS for sending here
      // ...

      res.status(200).json({ message: 'SMS messages queued for sending' });
    } catch (error) {
      // Rollback on error
      await pool.query('ROLLBACK');
      console.error('Error sending SMS:', error);
      res.status(500).json({ message: 'Server error while sending SMS' });
    }
  }
);

// Get SMS templates
router.get('/templates', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const query = `
      SELECT 
        id,
        name,
        template_text,
        purpose,
        created_at
      FROM 
        sms_templates
      ORDER BY 
        name ASC
    `;
    
    const result = await pool.query(query);
    
    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error fetching SMS templates:', error);
    res.status(500).json({ message: 'Server error while fetching SMS templates' });
  }
});

// Create SMS template
router.post('/templates',
  authorizeRoles('admin', 'teacher'),
  [
    body('name').notEmpty().withMessage('Template name is required'),
    body('templateText').notEmpty().withMessage('Template text is required'),
    body('purpose').notEmpty().withMessage('Purpose is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { name, templateText, purpose } = req.body;
    const createdById = req.user.id;
    
    try {
      const query = `
        INSERT INTO sms_templates
          (name, template_text, purpose, created_by)
        VALUES
          ($1, $2, $3, $4)
        RETURNING *
      `;
      
      const values = [name, templateText, purpose, createdById];
      const result = await pool.query(query, values);
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Error creating SMS template:', error);
      res.status(500).json({ message: 'Server error while creating SMS template' });
    }
  }
);

export default router;