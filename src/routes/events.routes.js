// routes/eventsRoutes.js
import express from 'express';
import { body, query, validationResult } from 'express-validator';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// Get all events
router.get('/', authorizeRoles('admin', 'teacher', 'staff', 'student', 'parent'), async (req, res) => {
  try {
    const { 
      event_type, 
      start_date, 
      end_date, 
      upcoming = 'false',
      limit = 50
    } = req.query;
    
    let queryText = `
      SELECT 
        e.id,
        e.title,
        e.description,
        e.event_date,
        e.start_time,
        e.end_time,
        e.location,
        e.event_type,
        e.is_public,
        e.created_at,
        u.username as created_by_name
      FROM 
        events e
      JOIN 
        users u ON e.created_by = u.id
      WHERE 1 = 1
    `;
    
    const queryParams = [];
    let paramIndex = 1;
    
    // Filter by event type
    if (event_type) {
      queryText += ` AND e.event_type = $${paramIndex}`;
      queryParams.push(event_type);
      paramIndex++;
    }
    
    // Filter by date range
    if (start_date) {
      queryText += ` AND e.event_date >= $${paramIndex}`;
      queryParams.push(start_date);
      paramIndex++;
    }
    
    if (end_date) {
      queryText += ` AND e.event_date <= $${paramIndex}`;
      queryParams.push(end_date);
      paramIndex++;
    }
    
    // Only show upcoming events
    if (upcoming === 'true') {
      queryText += ` AND e.event_date >= CURRENT_DATE`;
    }
    
    // Handle visibility for non-admin users
    if (!['admin', 'teacher', 'staff'].includes(req.user.role)) {
      queryText += ` AND e.is_public = true`;
    }
    
    // Order by date (upcoming first)
    queryText += ` ORDER BY e.event_date ASC`;
    
    // Limit results
    queryText += ` LIMIT $${paramIndex}`;
    queryParams.push(parseInt(limit));
    
    const events = await pool.query(queryText, queryParams);
    
    res.json(events.rows);
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).send('Server Error');
  }
});

// Get a single event by ID
router.get('/:id', authorizeRoles('admin', 'teacher', 'staff', 'student', 'parent'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const queryText = `
      SELECT 
        e.id,
        e.title,
        e.description,
        e.event_date,
        e.start_time,
        e.end_time,
        e.location,
        e.event_type,
        e.is_public,
        e.created_at,
        u.username as created_by_name
      FROM 
        events e
      JOIN 
        users u ON e.created_by = u.id
      WHERE 
        e.id = $1
    `;
    
    const event = await pool.query(queryText, [id]);
    
    if (event.rows.length === 0) {
      return res.status(404).json({ message: 'Event not found' });
    }
    
    // Check visibility for non-admin users
    if (!['admin', 'teacher', 'staff'].includes(req.user.role) && !event.rows[0].is_public) {
      return res.status(403).json({ message: 'You do not have permission to view this event' });
    }
    
    res.json(event.rows[0]);
  } catch (err) {
    console.error('Error fetching event:', err);
    res.status(500).send('Server Error');
  }
});

// Create a new event
router.post(
  '/',
  authorizeRoles('admin', 'teacher', 'staff'),
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('event_date').isDate().withMessage('Valid event date is required'),
    body('event_type').notEmpty().withMessage('Event type is required'),
    body('start_time').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).withMessage('Start time must be in a valid format (HH:MM or HH:MM:SS)'),
    body('end_time').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).withMessage('End time must be in a valid format (HH:MM or HH:MM:SS)'),
    body('is_public').isBoolean().withMessage('is_public must be a boolean value')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const {
      title,
      description,
      event_date,
      start_time,
      end_time,
      location,
      event_type,
      is_public = true
    } = req.body;
    
    try {
      const queryText = `
        INSERT INTO events (
          title,
          description,
          event_date,
          start_time,
          end_time,
          location,
          event_type,
          is_public,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `;
      
      const values = [
        title,
        description || null,
        event_date,
        start_time || null,
        end_time || null,
        location || null,
        event_type,
        is_public,
        req.user.id
      ];
      
      const result = await pool.query(queryText, values);
      
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('Error creating event:', err);
      res.status(500).send('Server Error');
    }
  }
);

// Update an event
router.put(
  '/:id',
  authorizeRoles('admin', 'teacher', 'staff'),
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('event_date').isDate().withMessage('Valid event date is required'),
    body('event_type').notEmpty().withMessage('Event type is required'),
    body('start_time').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).withMessage('Start time must be in a valid format (HH:MM or HH:MM:SS)'),
    body('end_time').optional().matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).withMessage('End time must be in a valid format (HH:MM or HH:MM:SS)'),
    body('is_public').isBoolean().withMessage('is_public must be a boolean value')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { id } = req.params;
    const {
      title,
      description,
      event_date,
      start_time,
      end_time,
      location,
      event_type,
      is_public = true
    } = req.body;
    
    try {
      // Check if the event exists and the user has permission to update it
      const eventCheck = await pool.query(
        'SELECT created_by FROM events WHERE id = $1',
        [id]
      );
      
      if (eventCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Event not found' });
      }
      
      // Only allow admin or the creator to update the event
      if (req.user.role !== 'admin' && eventCheck.rows[0].created_by !== req.user.id) {
        return res.status(403).json({ message: 'You do not have permission to update this event' });
      }
      
      const queryText = `
        UPDATE events
        SET
          title = $1,
          description = $2,
          event_date = $3,
          start_time = $4,
          end_time = $5,
          location = $6,
          event_type = $7,
          is_public = $8
        WHERE
          id = $9
        RETURNING *
      `;
      
      const values = [
        title,
        description || null,
        event_date,
        start_time || null,
        end_time || null,
        location || null,
        event_type,
        is_public,
        id
      ];
      
      const result = await pool.query(queryText, values);
      
      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error updating event:', err);
      res.status(500).send('Server Error');
    }
  }
);

// Delete an event
router.delete('/:id', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if the event exists and the user has permission to delete it
    const eventCheck = await pool.query(
      'SELECT created_by FROM events WHERE id = $1',
      [id]
    );
    
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Event not found' });
    }
    
    // Only allow admin or the creator to delete the event
    if (req.user.role !== 'admin' && eventCheck.rows[0].created_by !== req.user.id) {
      return res.status(403).json({ message: 'You do not have permission to delete this event' });
    }
    
    // Delete the event
    await pool.query('DELETE FROM events WHERE id = $1', [id]);
    
    res.json({ message: 'Event deleted successfully' });
  } catch (err) {
    console.error('Error deleting event:', err);
    res.status(500).send('Server Error');
  }
});

export default router;