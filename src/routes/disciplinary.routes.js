import express from "express";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import pool from "../config/database.js";

const router = express.Router();

// Apply authentication middleware to all dashboard routes
router.use(authenticateToken);

/**
 * @route   GET /api/disciplinary/incidents
 * @desc    Get all disciplinary incidents
 * @access  Private (Admin, Teachers)
 */
router.get('/incidents', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { searchQuery, statusFilter, fromDate, toDate, classFilter, severityFilter } = req.query;
      
      let query = `
        SELECT di.*, s.first_name || ' ' || s.last_name AS student_name, 
        s.admission_number AS admission_number, s.current_class AS grade,
        u.username AS reported_by_name
        FROM disciplinary_incidents di
        JOIN students s ON di.student_id = s.id
        JOIN users u ON di.reported_by = u.id
        WHERE 1=1
      `;
      
      const queryParams = [];
      let paramCounter = 1;
      
      // Add filters to query
      if (searchQuery) {
        query += ` AND (
          s.first_name ILIKE $${paramCounter} OR 
          s.last_name ILIKE $${paramCounter} OR 
          s.admission_number ILIKE $${paramCounter} OR
          di.description ILIKE $${paramCounter}
        )`;
        queryParams.push(`%${searchQuery}%`);
        paramCounter++;
      }
      
      if (statusFilter && statusFilter !== 'all') {
        query += ` AND di.status = $${paramCounter}`;
        queryParams.push(statusFilter);
        paramCounter++;
      }
      
      if (fromDate && toDate) {
        query += ` AND di.date BETWEEN $${paramCounter} AND $${paramCounter + 1}`;
        queryParams.push(fromDate, toDate);
        paramCounter += 2;
      }
      
      if (classFilter) {
        query += ` AND s.current_class = $${paramCounter}`;
        queryParams.push(classFilter);
        paramCounter++;
      }
      
      if (severityFilter) {
        query += ` AND di.severity = $${paramCounter}`;
        queryParams.push(severityFilter);
        paramCounter++;
      }
      
      query += ` ORDER BY di.date DESC`;
      
      const incidents = await pool.query(query, queryParams);
      res.json(incidents.rows);
    } catch (err) {
      console.error('Error fetching disciplinary incidents:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route   GET /api/disciplinary/incidents/:id
   * @desc    Get single disciplinary incident by ID
   * @access  Private (Admin, Teachers)
   */
  router.get('/incidents/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { id } = req.params;
      
      const query = `
        SELECT di.*, s.first_name || ' ' || s.last_name AS student_name, 
        s.admission_number AS admission_number, s.current_class AS grade,
        u.username AS reported_by_name
        FROM disciplinary_incidents di
        JOIN students s ON di.student_id = s.id
        JOIN users u ON di.reported_by = u.id
        WHERE di.id = $1
      `;
      
      const incident = await pool.query(query, [id]);
      
      if (incident.rows.length === 0) {
        return res.status(404).json({ message: 'Incident not found' });
      }
      
      res.json(incident.rows[0]);
    } catch (err) {
      console.error('Error fetching disciplinary incident:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route   POST /api/disciplinary/incidents
   * @desc    Create a new disciplinary incident
   * @access  Private (Admin, Teachers)
   */
  router.post('/incidents', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { 
        admissionNumber, 
        date, 
        type, 
        severity, 
        description, 
        location, 
        witnesses, 
        action, 
        status, 
        followUp 
      } = req.body;
      
      // Validate student exists by admission number
      const studentCheck = await pool.query('SELECT id FROM students WHERE admission_number = $1', [admissionNumber]);
      if (studentCheck.rows.length === 0) {
        return res.status(400).json({ message: 'Student not found' });
      }
      
      const student = studentCheck.rows[0];
      
      const query = `
        INSERT INTO disciplinary_incidents 
        (student_id, reported_by, date, type, severity, description, location, 
        witnesses, action, status, follow_up) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
      `;
      
      const values = [
        student.id,
        req.user.id, // Current logged in user from auth middleware
        date,
        type,
        severity,
        description,
        location,
        witnesses,
        action,
        status || 'Pending',
        followUp
      ];
      
      const result = await pool.query(query, values);
      
      // Fetch complete incident details including student name
      const newIncident = await pool.query(`
        SELECT di.*, s.first_name || ' ' || s.last_name AS student_name, 
        s.admission_number AS admission_number, s.current_class AS grade
        FROM disciplinary_incidents di
        JOIN students s ON di.student_id = s.id
        WHERE di.id = $1
      `, [result.rows[0].id]);
      
      res.status(201).json(newIncident.rows[0]);
    } catch (err) {
      console.error('Error creating disciplinary incident:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route   PUT /api/disciplinary/incidents/:id
   * @desc    Update a disciplinary incident
   * @access  Private (Admin, Teachers)
   */
  router.put('/incidents/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { id } = req.params;
      const { 
        date, 
        type, 
        severity, 
        description, 
        location, 
        witnesses, 
        action, 
        status, 
        followUp,
        resolutionNotes
      } = req.body;
      
      // Check if incident exists
      const incidentCheck = await pool.query('SELECT * FROM disciplinary_incidents WHERE id = $1', [id]);
      if (incidentCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Incident not found' });
      }
      
      const query = `
        UPDATE disciplinary_incidents
        SET date = $1, type = $2, severity = $3, description = $4, location = $5,
        witnesses = $6, action = $7, status = $8, follow_up = $9, resolution_notes = $10,
        updated_at = NOW()
        WHERE id = $11
        RETURNING *
      `;
      
      const values = [
        date,
        type,
        severity,
        description,
        location,
        witnesses,
        action,
        status,
        followUp,
        resolutionNotes,
        id
      ];
      
      const result = await pool.query(query, values);
      
      // If status changed to Resolved, record action
      if (status === 'Resolved' && incidentCheck.rows[0].status !== 'Resolved') {
        await pool.query(`
          INSERT INTO disciplinary_actions
          (incident_id, action_date, action_type, performed_by, notes)
          VALUES ($1, $2, $3, $4, $5)
        `, [id, new Date(), 'Resolution', req.user.id, resolutionNotes || 'Case resolved']);
      }
      
      // Fetch complete incident details including student name
      const updatedIncident = await pool.query(`
        SELECT di.*, s.first_name || ' ' || s.last_name AS student_name, 
        s.admission_number AS admission_number, s.current_class AS grade
        FROM disciplinary_incidents di
        JOIN students s ON di.student_id = s.id
        WHERE di.id = $1
      `, [id]);
      
      res.json(updatedIncident.rows[0]);
    } catch (err) {
      console.error('Error updating disciplinary incident:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route   DELETE /api/disciplinary/incidents/:id
   * @desc    Delete a disciplinary incident
   * @access  Private (Admin only)
   */
  router.delete('/incidents/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { id } = req.params;
      
      // Check if user has admin role
      if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Not authorized to delete incidents' });
      }
      
      // Delete associated actions first (due to foreign key constraint)
      await pool.query('DELETE FROM disciplinary_actions WHERE incident_id = $1', [id]);
      
      // Now delete the incident
      const result = await pool.query('DELETE FROM disciplinary_incidents WHERE id = $1 RETURNING id', [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'Incident not found' });
      }
      
      res.json({ message: 'Incident deleted successfully', id });
    } catch (err) {
      console.error('Error deleting disciplinary incident:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route   GET /api/disciplinary/analytics
   * @desc    Get analytics data for disciplinary incidents
   * @access  Private (Admin, Teachers)
   */
  router.get('/analytics', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      // Get period from query params or default to current year
      const { period } = req.query;
      const currentYear = new Date().getFullYear();
      
      let dateFilter = '';
      if (period === 'month') {
        const currentMonth = new Date().getMonth() + 1;
        dateFilter = `AND EXTRACT(MONTH FROM date) = ${currentMonth} AND EXTRACT(YEAR FROM date) = ${currentYear}`;
      } else if (period === 'year') {
        dateFilter = `AND EXTRACT(YEAR FROM date) = ${currentYear}`;
      }
      
      // Get total incidents by type
      const incidentsByType = await pool.query(`
        SELECT type, COUNT(*) as count
        FROM disciplinary_incidents
        WHERE 1=1 ${dateFilter}
        GROUP BY type
        ORDER BY count DESC
      `);
      
      // Get incidents by severity
      const incidentsBySeverity = await pool.query(`
        SELECT severity, COUNT(*) as count
        FROM disciplinary_incidents
        WHERE 1=1 ${dateFilter}
        GROUP BY severity
        ORDER BY 
          CASE 
            WHEN severity = 'Severe' THEN 1
            WHEN severity = 'Moderate' THEN 2
            WHEN severity = 'Minor' THEN 3
            ELSE 4
          END
      `);
      
      // Get incidents by status
      const incidentsByStatus = await pool.query(`
        SELECT status, COUNT(*) as count
        FROM disciplinary_incidents
        WHERE 1=1 ${dateFilter}
        GROUP BY status
      `);
      
      // Get incidents by month (for current year)
      const incidentsByMonth = await pool.query(`
        SELECT EXTRACT(MONTH FROM date) as month, COUNT(*) as count
        FROM disciplinary_incidents
        WHERE EXTRACT(YEAR FROM date) = ${currentYear}
        GROUP BY month
        ORDER BY month
      `);
      
      // Get top 5 classes with most incidents
      const incidentsByClass = await pool.query(`
        SELECT s.current_class as class, COUNT(*) as count
        FROM disciplinary_incidents di
        JOIN students s ON di.student_id = s.id
        WHERE 1=1 ${dateFilter}
        GROUP BY class
        ORDER BY count DESC
        LIMIT 5
      `);
      
      res.json({
        incidentsByType: incidentsByType.rows,
        incidentsBySeverity: incidentsBySeverity.rows,
        incidentsByStatus: incidentsByStatus.rows,
        incidentsByMonth: incidentsByMonth.rows,
        incidentsByClass: incidentsByClass.rows
      });
    } catch (err) {
      console.error('Error fetching disciplinary analytics:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route   GET /api/disciplinary/actions/:incidentId
   * @desc    Get all actions for a specific incident
   * @access  Private (Admin, Teachers)
   */
  router.get('/actions/:incidentId', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { incidentId } = req.params;
      
      const query = `
        SELECT da.*, u.username AS performed_by_name
        FROM disciplinary_actions da
        JOIN users u ON da.performed_by = u.id
        WHERE da.incident_id = $1
        ORDER BY da.action_date DESC
      `;
      
      const actions = await pool.query(query, [incidentId]);
      res.json(actions.rows);
    } catch (err) {
      console.error('Error fetching disciplinary actions:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route   POST /api/disciplinary/actions
   * @desc    Add a new action to an incident
   * @access  Private (Admin, Teachers)
   */
  router.post('/actions', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { incidentId, actionType, notes } = req.body;
      
      // Check if incident exists
      const incidentCheck = await pool.query('SELECT * FROM disciplinary_incidents WHERE id = $1', [incidentId]);
      if (incidentCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Incident not found' });
      }
      
      const query = `
        INSERT INTO disciplinary_actions
        (incident_id, action_date, action_type, performed_by, notes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
      
      const values = [
        incidentId,
        new Date(),
        actionType,
        req.user.id,
        notes
      ];
      
      const result = await pool.query(query, values);
      
      // Get action with performer name
      const newAction = await pool.query(`
        SELECT da.*, u.username AS performed_by_name
        FROM disciplinary_actions da
        JOIN users u ON da.performed_by = u.id
        WHERE da.id = $1
      `, [result.rows[0].id]);
      
      res.status(201).json(newAction.rows[0]);
    } catch (err) {
      console.error('Error creating disciplinary action:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });


export default router