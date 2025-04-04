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
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
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
      follow_up,
      // New status change fields
      affects_status,
      status_change,
      effective_date,
      end_date,
      auto_restore
    } = req.body;
    
    // Handle empty date values
    const formattedFollowUp = follow_up === "" ? null : follow_up;
    const formattedEffectiveDate = effective_date === "" ? null : effective_date;
    const formattedEndDate = end_date === "" ? null : end_date;
    
    // Validate student exists by admission number
    const studentCheck = await client.query('SELECT id, status FROM students WHERE admission_number = $1', [admissionNumber]);
    if (studentCheck.rows.length === 0) {
      return res.status(400).json({ message: 'Student not found' });
    }
    
    const student = studentCheck.rows[0];
    
    // Insert the disciplinary incident
    const incidentQuery = `
      INSERT INTO disciplinary_incidents 
      (student_id, reported_by, date, type, severity, description, location, 
      witnesses, action, status, follow_up, affects_status, status_change, 
      effective_date, end_date, auto_restore) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `;
    
    const incidentValues = [
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
      formattedFollowUp,  // Use the formatted value
      affects_status || false,
      status_change,
      formattedEffectiveDate,  // Use the formatted value
      formattedEndDate,  // Use the formatted value
      auto_restore || true
    ];
    
    const incidentResult = await client.query(incidentQuery, incidentValues);
    const newIncident = incidentResult.rows[0];
    
    // If incident affects student status, update the student status and create status history
    if (affects_status && status_change) {
      // Update student status
      await client.query(
        'UPDATE students SET status = $1, updated_at = NOW() WHERE id = $2',
        [status_change, student.id]
      );
      
      // Record in status history
      await client.query(
        `INSERT INTO student_status_history 
        (student_id, previous_status, new_status, effective_date, end_date, 
        reason_type, disciplinary_action_id, created_by, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          student.id,
          student.status,
          status_change,
          formattedEffectiveDate || new Date(),  // Use formatted value
          formattedEndDate,  // Use formatted value
          'disciplinary',
          newIncident.id,
          req.user.id,
          `Status change due to disciplinary incident: ${type} - ${description.substring(0, 50)}...`
        ]
      );
    }
    
    await client.query('COMMIT');
    
    // Fetch complete incident details including student name
    const completeIncident = await pool.query(`
      SELECT di.*, s.first_name || ' ' || s.last_name AS student_name, 
      s.admission_number, s.current_class AS grade
      FROM disciplinary_incidents di
      JOIN students s ON di.student_id = s.id
      WHERE di.id = $1
    `, [newIncident.id]);
    
    res.status(201).json(completeIncident.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating disciplinary incident:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

/**
 * @route   PUT /api/disciplinary/incidents/:id
 * @desc    Update a disciplinary incident
 * @access  Private (Admin, Teachers)
 */
router.put('/incidents/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
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
      follow_up,
      resolution_notes,
      // Status change fields
      affects_status,
      status_change,
      effective_date,
      end_date,
      auto_restore
    } = req.body;
    
    // Check if incident exists and get current data
    const incidentCheck = await client.query(
      'SELECT * FROM disciplinary_incidents WHERE id = $1', 
      [id]
    );
    
    if (incidentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Incident not found' });
    }
    
    const existingIncident = incidentCheck.rows[0];
    
    // Handle empty date values
    const formattedFollowUp = follow_up === "" ? null : follow_up;
    const formattedEffectiveDate = effective_date === "" ? null : effective_date;
    const formattedEndDate = end_date === "" ? null : end_date;
    
    // Update the incident
    const updateQuery = `
      UPDATE disciplinary_incidents
      SET date = $1, type = $2, severity = $3, description = $4, location = $5,
      witnesses = $6, action = $7, status = $8, follow_up = $9, resolution_notes = $10,
      affects_status = $11, status_change = $12, effective_date = $13, end_date = $14, 
      auto_restore = $15, updated_at = NOW()
      WHERE id = $16
      RETURNING *
    `;
    
    const updateValues = [
      date,
      type,
      severity,
      description,
      location,
      witnesses,
      action,
      status,
      formattedFollowUp,  // Use the formatted value
      resolution_notes,
      affects_status || false,
      status_change,
      formattedEffectiveDate,  // Use the formatted value
      formattedEndDate,  // Use the formatted value
      auto_restore !== undefined ? auto_restore : true,
      id
    ];
    
    const updateResult = await client.query(updateQuery, updateValues);
    const updatedIncident = updateResult.rows[0];
    
    // Handle status change updates
    if (affects_status && status_change) {
      // Get the student details
      const student = await client.query(
        'SELECT id, status FROM students WHERE id = $1',
        [updatedIncident.student_id]
      );
      
      if (student.rows.length > 0) {
        const studentData = student.rows[0];
        
        // Status change is new or different
        if (!existingIncident.affects_status || 
            existingIncident.status_change !== status_change ||
            existingIncident.end_date !== end_date) {
          
          // Update student status
          await client.query(
            'UPDATE students SET status = $1, updated_at = NOW() WHERE id = $2',
            [status_change, studentData.id]
          );
          
          // If there's an existing status history entry, update it
          const historyExists = await client.query(
            'SELECT id FROM student_status_history WHERE disciplinary_action_id = $1',
            [id]
          );
          
          if (historyExists.rows.length > 0) {
            await client.query(
              `UPDATE student_status_history
              SET new_status = $1, effective_date = $2, end_date = $3, auto_restore = $4, updated_at = NOW()
              WHERE disciplinary_action_id = $5`,
              [status_change, effective_date, end_date, auto_restore, id]
            );
          } else {
            // Create new status history entry
            await client.query(
              `INSERT INTO student_status_history 
              (student_id, previous_status, new_status, effective_date, end_date, 
              reason_type, disciplinary_action_id, created_by, notes)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                studentData.id,
                studentData.status,
                status_change,
                effective_date || new Date(),
                end_date,
                'disciplinary',
                id,
                req.user.id,
                `Updated status change due to disciplinary incident: ${type}`
              ]
            );
          }
        }
      }
    } else if (!affects_status && existingIncident.affects_status) {
      // Status change was removed - revert student status if needed
      const student = await client.query(
        'SELECT id FROM students WHERE id = $1 AND status = $2',
        [updatedIncident.student_id, existingIncident.status_change]
      );
      
      if (student.rows.length > 0) {
        // Check status history to find previous status
        const statusHistory = await client.query(
          `SELECT previous_status FROM student_status_history 
          WHERE disciplinary_action_id = $1`,
          [id]
        );
        
        const previousStatus = statusHistory.rows.length > 0 
          ? statusHistory.rows[0].previous_status 
          : 'active';
        
        // Revert student status
        await client.query(
          'UPDATE students SET status = $1, updated_at = NOW() WHERE id = $2',
          [previousStatus, updatedIncident.student_id]
        );
        
        // Update status history as reverted
        await client.query(
          `UPDATE student_status_history
          SET notes = CONCAT(notes, ' | Reverted on ', NOW()::date)
          WHERE disciplinary_action_id = $1`,
          [id]
        );
      }
    }
    
    // If status changed to Resolved, record action
    if (status === 'Resolved' && existingIncident.status !== 'Resolved') {
      await client.query(`
        INSERT INTO disciplinary_actions
        (incident_id, action_date, action_type, performed_by, notes)
        VALUES ($1, $2, $3, $4, $5)
      `, [id, new Date(), 'Resolution', req.user.id, resolution_notes || 'Case resolved']);
    }
    
    await client.query('COMMIT');
    
    // Fetch complete incident details including student name
    const completeIncident = await pool.query(`
      SELECT di.*, s.first_name || ' ' || s.last_name AS student_name, 
      s.admission_number, s.current_class AS grade
      FROM disciplinary_incidents di
      JOIN students s ON di.student_id = s.id
      WHERE di.id = $1
    `, [id]);
    
    res.json(completeIncident.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating disciplinary incident:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});
/**
 * @route   DELETE /api/disciplinary/incidents/:id
 * @desc    Delete a disciplinary incident
 * @access  Private (Admin only)
 */
router.delete('/incidents/:id', authorizeRoles('admin'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    
    // Check if incident exists and get status change info
    const incidentCheck = await client.query(
      'SELECT student_id, affects_status, status_change FROM disciplinary_incidents WHERE id = $1',
      [id]
    );
    
    if (incidentCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Incident not found' });
    }
    
    const incident = incidentCheck.rows[0];
    
    // If incident affected student status, we may need to revert it
    if (incident.affects_status && incident.status_change) {
      // Check if student still has this status
      const student = await client.query(
        'SELECT status FROM students WHERE id = $1',
        [incident.student_id]
      );
      
      if (student.rows.length > 0 && student.rows[0].status === incident.status_change) {
        // Get previous status from history
        const statusHistory = await client.query(
          `SELECT previous_status FROM student_status_history
          WHERE disciplinary_action_id = $1`,
          [id]
        );
        
        const previousStatus = statusHistory.rows.length > 0
          ? statusHistory.rows[0].previous_status
          : 'active';
        
        // Revert student status
        await client.query(
          'UPDATE students SET status = $1, updated_at = NOW() WHERE id = $2',
          [previousStatus, incident.student_id]
        );
        
        // Mark status history entry as deleted
        await client.query(
          `UPDATE student_status_history
          SET notes = CONCAT(notes, ' | Deleted on ', NOW()::date)
          WHERE disciplinary_action_id = $1`,
          [id]
        );
      }
    }
    
    // Delete associated actions first (due to foreign key constraint)
    await client.query('DELETE FROM disciplinary_actions WHERE incident_id = $1', [id]);
    
    // Now delete the incident
    const result = await client.query('DELETE FROM disciplinary_incidents WHERE id = $1 RETURNING id', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Incident not found' });
    }
    
    await client.query('COMMIT');
    
    res.json({ message: 'Incident deleted successfully', id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting disciplinary incident:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
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
 * @route   GET /api/disciplinary/analytics/extended
 * @desc    Get extended analytics including status change data
 * @access  Private (Admin, Teachers)
 */
router.get('/analytics/extended', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    // Get period from query params or default to current year
    const { period } = req.query;
    const currentYear = new Date().getFullYear();
    
    let dateFilter = '';
    if (period === 'month') {
      const currentMonth = new Date().getMonth() + 1;
      dateFilter = `AND EXTRACT(MONTH FROM di.date) = ${currentMonth} AND EXTRACT(YEAR FROM di.date) = ${currentYear}`;
    } else if (period === 'term') {
      // Assuming term periods (adjust as needed)
      dateFilter = `AND di.date >= (SELECT start_date FROM academic_sessions WHERE is_current = true)
                    AND di.date <= (SELECT end_date FROM academic_sessions WHERE is_current = true)`;
    } else {
      // Default to year
      dateFilter = `AND EXTRACT(YEAR FROM di.date) = ${currentYear}`;
    }
    
    // Basic analytics (similar to regular analytics)
    const basicAnalyticsQuery = `
      SELECT 
        COUNT(*) as total_incidents,
        COUNT(*) FILTER (WHERE status = 'Pending') as pending_incidents,
        COUNT(*) FILTER (WHERE status = 'In Progress') as in_progress_incidents,
        COUNT(*) FILTER (WHERE status = 'Resolved') as resolved_incidents,
        COUNT(*) FILTER (WHERE severity = 'Minor') as minor_incidents,
        COUNT(*) FILTER (WHERE severity = 'Moderate') as moderate_incidents,
        COUNT(*) FILTER (WHERE severity = 'Severe') as severe_incidents
      FROM disciplinary_incidents di
      WHERE 1=1 ${dateFilter}
    `;
    
    // Status change analytics
    const statusChangeQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE affects_status = true) as status_changes,
        COUNT(*) FILTER (WHERE affects_status = true AND status_change = 'expelled') as expulsions,
        COUNT(*) FILTER (WHERE affects_status = true AND status_change = 'suspended') as suspensions,
        COUNT(*) FILTER (WHERE affects_status = true AND status_change = 'on_probation') as probations,
        COUNT(*) FILTER (WHERE affects_status = true AND auto_restore = true) as auto_restores
      FROM disciplinary_incidents di
      WHERE 1=1 ${dateFilter}
    `;
    
    // Get currently active status changes
    const currentStatusChangesQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE s.status = 'suspended') as current_suspensions,
        COUNT(*) FILTER (WHERE s.status = 'on_probation') as current_probations,
        COUNT(*) FILTER (WHERE s.status = 'expelled') as current_expulsions
      FROM students s
      WHERE s.status IN ('suspended', 'on_probation', 'expelled')
    `;
    
    // Execute queries
    const [basicAnalytics, statusChanges, currentStatusChanges] = await Promise.all([
      pool.query(basicAnalyticsQuery),
      pool.query(statusChangeQuery),
      pool.query(currentStatusChangesQuery)
    ]);
    
    // Get previous period data for comparison
    let previousPeriodFilter = '';
    if (period === 'month') {
      const previousMonth = new Date().getMonth(); // 0-based, so current_month - 1
      const yearOfPreviousMonth = previousMonth === 0 ? currentYear - 1 : currentYear;
      const previousMonthNumber = previousMonth === 0 ? 12 : previousMonth;
      previousPeriodFilter = `AND EXTRACT(MONTH FROM date) = ${previousMonthNumber} AND EXTRACT(YEAR FROM date) = ${yearOfPreviousMonth}`;
    } else if (period === 'term') {
      // This would require knowledge of the previous term's dates
      previousPeriodFilter = `AND false`; // Placeholder, replace with actual previous term logic
    } else {
      // Previous year
      previousPeriodFilter = `AND EXTRACT(YEAR FROM date) = ${currentYear - 1}`;
    }
    
    const previousPeriodQuery = `
      SELECT COUNT(*) as count
      FROM disciplinary_incidents
      WHERE 1=1 ${previousPeriodFilter}
    `;
    
    const previousPeriod = await pool.query(previousPeriodQuery);
    
    res.json({
      ...basicAnalytics.rows[0],
      ...statusChanges.rows[0],
      ...currentStatusChanges.rows[0],
      previousPeriodIncidents: parseInt(previousPeriod.rows[0].count)
    });
  } catch (err) {
    console.error('Error fetching extended disciplinary analytics:', err);
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

/**
 * @route   GET /api/disciplinary/action-status-mappings
 * @desc    Get mappings between disciplinary actions and student status changes
 * @access  Private (Admin, Teachers)
 */
router.get('/action-status-mappings', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const query = `
      SELECT * FROM disciplinary_action_status_mappings 
      ORDER BY action_type
    `;
    
    const mappings = await pool.query(query);
    res.json(mappings.rows);
  } catch (err) {
    console.error('Error fetching action status mappings:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route   GET /api/disciplinary/students/:studentId/incidents
 * @desc    Get all incidents for a specific student
 * @access  Private (Admin, Teachers)
 */
router.get('/students/:studentId/incidents', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const query = `
      SELECT di.*, u.username AS reported_by_name
      FROM disciplinary_incidents di
      JOIN users u ON di.reported_by = u.id
      WHERE di.student_id = $1
      ORDER BY di.date DESC
    `;
    
    const incidents = await pool.query(query, [studentId]);
    res.json(incidents.rows);
  } catch (err) {
    console.error('Error fetching student incidents:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route   GET /api/students/:studentId/status-history
 * @desc    Get status change history for a student
 * @access  Private (Admin, Teachers)
 */
router.get('/students/:studentId/status-history', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { studentId } = req.params;
    console.log(studentId)
    const query = `
  SELECT 
    ssh.*,
    CASE 
        WHEN ssh.created_by IS NULL THEN 'System Automation'
        ELSE u.username 
    END AS created_by_name
FROM student_status_history ssh
LEFT JOIN users u ON ssh.created_by = u.id
WHERE ssh.student_id = $1
ORDER BY ssh.effective_date DESC, ssh.id DESC
    `;
    
    const history = await pool.query(query, [studentId]);
    res.json(history.rows);
  } catch (err) {
    console.error('Error fetching student status history:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route   GET /api/students/:studentId/status
 * @desc    Get current status of a student
 * @access  Private (Admin, Teachers)
 */
router.get('/students/:studentId/status', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const query = `
      SELECT id, status, 
      (SELECT end_date FROM student_status_history 
       WHERE student_id = students.id
       ORDER BY effective_date DESC LIMIT 1) AS status_end_date
      FROM students
      WHERE id = $1
    `;
    
    const result = await pool.query(query, [studentId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching student status:', err);
    res.status(500).json({ message: 'Server error' });
  }
});
/**
 * @route   GET /api/students/admission/:admissionNumber
 * @desc    Get student by admission number
 * @access  Private (Admin, Teachers)
 */
router.get('/students/admission/:admissionNumber', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    
    const query = `
      SELECT id, first_name, last_name, admission_number, current_class, stream, status
      FROM students
      WHERE admission_number = $1
    `;
    
    const result = await pool.query(query, [admissionNumber]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching student by admission number:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route   GET /api/disciplinary/active-statuses
 * @desc    Get count of currently active disciplinary statuses
 * @access  Private (Admin, Teachers)
 */
router.get('/active-statuses', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'suspended') as suspended_count,
        COUNT(*) FILTER (WHERE status = 'on_probation') as probation_count,
        COUNT(*) FILTER (WHERE status = 'expelled') as expelled_count
      FROM students
      WHERE status IN ('suspended', 'on_probation', 'expelled')
    `;
    
    const result = await pool.query(query);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching active disciplinary statuses:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

/**
 * @route   POST /api/students/:studentId/restore-status
 * @desc    Manually restore a student's status
 * @access  Private (Admin only)
 */
router.post('/students/:studentId/restore-status', authorizeRoles('admin'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { studentId } = req.params;
    const { notes } = req.body;
    
    // Get current student status
    const studentQuery = await client.query(
      'SELECT status FROM students WHERE id = $1',
      [studentId]
    );
    
    if (studentQuery.rows.length === 0) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    const currentStatus = studentQuery.rows[0].status;
    
    // Only restore if current status is not 'active'
    if (currentStatus === 'active') {
      return res.status(400).json({ message: 'Student status is already active' });
    }
    
    // Get previous status from history
    const historyQuery = await client.query(
      `SELECT previous_status FROM student_status_history 
      WHERE student_id = $1 
      ORDER BY effective_date DESC, id DESC 
      LIMIT 1`,
      [studentId]
    );
    
    const previousStatus = historyQuery.rows.length > 0 
      ? historyQuery.rows[0].previous_status 
      : 'active';
    
    // Update student status
    await client.query(
      'UPDATE students SET status = $1, updated_at = NOW() WHERE id = $2',
      [previousStatus, studentId]
    );
    
    // Record manual status restoration in history
    await client.query(
      `INSERT INTO student_status_history 
      (student_id, previous_status, new_status, effective_date, reason_type, created_by, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        studentId,
        currentStatus,
        previousStatus,
        new Date(),
        'manual_restoration',
        req.user.id,
        notes || 'Manual status restoration by administrator'
      ]
    );
    
    await client.query('COMMIT');
    
    res.json({ 
      message: 'Student status restored successfully',
      previous_status: currentStatus,
      current_status: previousStatus
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error restoring student status:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});

/**
 * @route   GET /api/disciplinary/pending-restorations
 * @desc    Get students with status changes due for restoration
 * @access  Private (Admin, Teachers)
 */
router.get('/pending-restorations', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const query = `
      SELECT s.id, s.first_name, s.last_name, s.admission_number, s.current_class,
             s.stream, s.status, ssh.end_date, ssh.previous_status, 
             ssh.disciplinary_action_id, ssh.auto_restore
      FROM students s
      JOIN student_status_history ssh ON s.id = ssh.student_id
      WHERE s.status IN ('suspended', 'on_probation')
      AND ssh.end_date IS NOT NULL
      AND ssh.end_date <= (CURRENT_DATE + INTERVAL '7 day')
      AND ssh.auto_restore = true
      ORDER BY ssh.end_date ASC
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching pending status restorations:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
