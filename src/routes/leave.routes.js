import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// Get leave requests (with filters)
router.get('/',  authorizeRoles("admin", "librarian", "teacher", "student"), async (req, res) => {
  try {
    const { 
      status, 
      teacher_id, 
      start_date, 
      end_date,
      leave_type_id,
      page = 1,
      limit = 10
    } = req.query;
    
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT 
        lr.id, lr.start_date, lr.end_date, lr.days_count, 
        lr.reason, lr.status, lr.created_at, lr.approval_date,
        lr.rejection_reason, lr.attachment_url,
        lt.name AS leave_type,
        t.first_name || ' ' || t.last_name AS teacher_name,
        t.staff_id AS teacher_staff_id,
        t.photo_url AS teacher_photo,
        st.first_name || ' ' || st.last_name AS substitute_teacher_name,
        u.username AS approved_by_username
      FROM leave_requests lr
      JOIN teachers t ON lr.teacher_id = t.id
      JOIN leave_types lt ON lr.leave_type_id = lt.id
      LEFT JOIN teachers st ON lr.substitute_teacher_id = st.id
      LEFT JOIN users u ON lr.approved_by = u.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    // Add filters if provided
    if (status) {
      queryParams.push(status);
      query += ` AND lr.status = $${queryParams.length}`;
    }
    
    if (teacher_id) {
      queryParams.push(teacher_id);
      query += ` AND lr.teacher_id = $${queryParams.length}`;
    }
    
    if (start_date) {
      queryParams.push(start_date);
      query += ` AND lr.start_date >= $${queryParams.length}`;
    }
    
    if (end_date) {
      queryParams.push(end_date);
      query += ` AND lr.end_date <= $${queryParams.length}`;
    }
    
    if (leave_type_id) {
      queryParams.push(leave_type_id);
      query += ` AND lr.leave_type_id = $${queryParams.length}`;
    }
    
    // Add sorting and pagination
    query += ` ORDER BY lr.created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, queryParams);
    
    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) FROM leave_requests lr
      WHERE 1=1
      ${status ? ` AND lr.status = $1` : ''}
      ${teacher_id ? ` AND lr.teacher_id = $${status ? 2 : 1}` : ''}
    `;
    
    const countParams = [];
    if (status) countParams.push(status);
    if (teacher_id) countParams.push(teacher_id);
    
    const countResult = await pool.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].count);
    
    res.json({
      results: result.rows,
      pagination: {
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        currentPage: parseInt(page),
        hasNextPage: offset + limit < totalCount,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching leave requests:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// routes/leaveRequests.js (continued)

// Create a new leave request
router.post('/',  authorizeRoles("admin", "librarian", "teacher", "student"), async (req, res) => {
  const client = await pool.connect();
 
  try {
    const {
      teacher_id,
      leave_type_id,
      start_date,
      end_date,
      reason,
      substitute_teacher_id,
      attachment_url
    } = req.body;
    console.log(req.body);
   
    // Validate required fields
    if (!teacher_id || !leave_type_id || !start_date || !end_date || !reason) {
      return res.status(400).json({
        message: 'Missing required fields'
      });
    }
   
    // Calculate days count (excluding weekends)
    const days_count = await calculateWorkingDays(start_date, end_date);
    
    // Begin transaction
    await client.query('BEGIN');
    
    // Get current academic year
    const academicYearQuery = `
      SELECT CONCAT(year, '-', (year::integer + 1)) AS academic_year
      FROM academic_sessions
      WHERE is_current = true
      LIMIT 1
    `;
    
    const academicYearResult = await client.query(academicYearQuery);
    const academicYear = academicYearResult.rows.length > 0 
      ? academicYearResult.rows[0].academic_year 
      : '2024-2025'; // Fallback
   
    // Check leave balance
    const balanceQuery = `
      SELECT remaining_days
      FROM leave_balances
      WHERE teacher_id = $1
      AND leave_type_id = $2
      AND academic_year = $3
    `;
   
    const balanceResult = await client.query(balanceQuery, [teacher_id, leave_type_id, academicYear]);
   
    if (balanceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'No leave balance found for this teacher and leave type'
      });
    }
   
    const remaining_days = balanceResult.rows[0].remaining_days;
   
    if (days_count > remaining_days) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Insufficient leave balance. Requested: ${days_count} days, Available: ${remaining_days} days`
      });
    }
   
    // Insert the leave request
    const insertQuery = `
      INSERT INTO leave_requests
        (teacher_id, leave_type_id, start_date, end_date, days_count,
         reason, substitute_teacher_id, attachment_url, status)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING *
    `;
   
    const insertResult = await client.query(insertQuery, [
      teacher_id,
      leave_type_id,
      start_date,
      end_date,
      days_count,
      reason,
      substitute_teacher_id || null,
      attachment_url || null
    ]);
   
    // Commit transaction
    await client.query('COMMIT');
   
    res.status(201).json(insertResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating leave request:', error);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
});
  // Helper function to calculate working days between two dates
  async function calculateWorkingDays(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    let count = 0;
    
    const current = new Date(start);
    while (current <= end) {
      const dayOfWeek = current.getDay();
      // Skip weekends (0 = Sunday, 6 = Saturday)
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }
    
    return count;
  }

  // routes/leaveRequests.js (continued)

// Update leave request status (approve/reject)
router.patch('/:id/status', authorizeRoles("admin", "librarian", "teacher", "student"), async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      const { status, rejection_reason } = req.body;
      const approved_by = req.user.id; // From authentication middleware
      
      if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ 
          message: 'Status must be either "approved" or "rejected"' 
        });
      }
      
      if (status === 'rejected' && !rejection_reason) {
        return res.status(400).json({ 
          message: 'Rejection reason is required' 
        });
      }
      
      // Begin transaction
      await client.query('BEGIN');
      
      // Get the leave request details
      const leaveQuery = `
        SELECT * FROM leave_requests WHERE id = $1
      `;
      
      const leaveResult = await client.query(leaveQuery, [id]);
      
      if (leaveResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ 
          message: 'Leave request not found' 
        });
      }
      
      const leaveRequest = leaveResult.rows[0];
      
      if (leaveRequest.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          message: `Cannot update status. Current status is already "${leaveRequest.status}"` 
        });
      }
      
      // Update the leave request status
      const updateQuery = `
        UPDATE leave_requests
        SET status = $1, 
            approved_by = $2, 
            approval_date = NOW(),
            rejection_reason = $3,
            updated_at = NOW()
        WHERE id = $4
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [
        status,
        approved_by,
        status === 'rejected' ? rejection_reason : null,
        id
      ]);
      
      // If approved, update the used_days in leave_balances
      if (status === 'approved') {
        const updateBalanceQuery = `
          UPDATE leave_balances
          SET used_days = used_days + $1,
              updated_at = NOW()
          WHERE teacher_id = $2
          AND leave_type_id = $3
          AND academic_year = '2024-2025' -- Should be dynamic
        `;
        
        await client.query(updateBalanceQuery, [
          leaveRequest.days_count,
          leaveRequest.teacher_id,
          leaveRequest.leave_type_id
        ]);
      }
      
      // Commit transaction
      await client.query('COMMIT');
      
      res.json(updateResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating leave request status:', error);
      res.status(500).json({ message: 'Server error' });
    } finally {
      client.release();
    }
  });

  router.get('/balances/:teacherId', authorizeRoles("admin", "librarian", "teacher", "student"), async (req, res) => {
    try {
      const { teacherId } = req.params;
      
      // Verify the teacher exists
      const teacherQuery = `
        SELECT id FROM teachers WHERE id = $1
      `;
      
      const teacherResult = await pool.query(teacherQuery, [teacherId]);
      
      if (teacherResult.rows.length === 0) {
        return res.status(404).json({ message: 'Teacher not found' });
      }
      
      // Get current academic year
      const academicYearQuery = `
        SELECT CONCAT(year, '-', (year::integer + 1)) AS academic_year
        FROM academic_sessions
        WHERE is_current = true
        LIMIT 1
      `;
      
      const academicYearResult = await pool.query(academicYearQuery);
      
      const academicYear = academicYearResult.rows.length > 0 
        ? academicYearResult.rows[0].academic_year 
        : '2024-2025'; // Fallback
      

      // Get leave balances for the teacher
      const balancesQuery = `
        SELECT 
          lb.id, 
          lb.academic_year, 
          lb.total_days, 
          lb.used_days, 
          lb.remaining_days,
          lt.id AS leave_type_id, 
          lt.name AS leave_type_name, 
          lt.description,
          lt.days_allowed
        FROM leave_balances lb
        JOIN leave_types lt ON lb.leave_type_id = lt.id
        WHERE lb.teacher_id = $1
        AND lb.academic_year = $2
        ORDER BY lt.name
      `;
      
      const balancesResult = await pool.query(balancesQuery, [teacherId, academicYear]);
      
      // If no balances found, initialize them
      if (balancesResult.rows.length === 0) {
        // Get teacher employment type
        const employmentQuery = `
          SELECT employment_type FROM teachers WHERE id = $1
        `;
        
        const employmentResult = await pool.query(employmentQuery, [teacherId]);
        const employmentType = employmentResult.rows[0].employment_type;
        
        // Get leave types
        const leaveTypesQuery = `
          SELECT id, name, days_allowed FROM leave_types WHERE is_active = true
        `;
        
        const leaveTypesResult = await pool.query(leaveTypesQuery);
        
        // Create new balances
        const client = await pool.connect();
        
        try {
          await client.query('BEGIN');
          
          for (const leaveType of leaveTypesResult.rows) {
            // Adjust days based on employment type
            let totalDays = leaveType.days_allowed;
            
            if (leaveType.name === 'Annual Leave') {
              if (employmentType === 'part-time') {
                totalDays = Math.floor(totalDays / 2); // Half for part-time
              } else if (employmentType === 'contract') {
                totalDays = Math.floor(totalDays / 3); // One-third for contract
              }
            }
            
            const insertQuery = `
              INSERT INTO leave_balances 
                (teacher_id, academic_year, leave_type_id, total_days, used_days)
              VALUES 
                ($1, $2, $3, $4, 0)
              RETURNING 
                id, academic_year, total_days, used_days, 
                total_days - used_days AS remaining_days
            `;
            
            await client.query(insertQuery, [
              teacherId, 
              academicYear, 
              leaveType.id, 
              totalDays
            ]);
          }
          
          await client.query('COMMIT');
          
          // Fetch the newly created balances
          const newBalancesResult = await pool.query(balancesQuery, [teacherId, academicYear]);
          console.log(newBalancesResult.rows)
          return res.json(newBalancesResult.rows);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      console.log(balancesResult.rows)
      res.json(balancesResult.rows);
    } catch (error) {
      console.error('Error fetching leave balances:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });

  // In your Express backend routes (e.g., routes/leaves.js)

/**
 * @route   POST /api/leaves/check-status-updates
 * @desc    Check and update teacher statuses for completed leaves
 * @access  Private (Admin)
 */
router.post('/check-status-updates',  authorizeRoles("admin", "librarian", "teacher", "student"), async (req, res) => {
  try {
    // Check if the user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: 'Only administrators can perform this operation' 
      });
    }

    // Call the database function to restore teacher statuses
    const result = await pool.query('SELECT restore_teacher_status_after_leave()');
    
    return res.json({ 
      success: true, 
      message: 'Teacher statuses updated successfully' 
    });
  } catch (error) {
    console.error('Error updating teacher statuses:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error while updating teacher statuses' 
    });
  }
});

/**
 * @route   GET /api/leaves/ending-today
 * @desc    Get all leaves ending today
 * @access  Private (Admin)
 */
router.get('/ending-today',  authorizeRoles("admin", "librarian", "teacher", "student"), async (req, res) => {
  try {
    // Check if the user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: 'Only administrators can access this information' 
      });
    }

    const query = `
      SELECT lr.*, t.first_name || ' ' || t.last_name AS teacher_name, lt.name AS leave_type_name 
      FROM leave_requests lr
      JOIN teachers t ON lr.teacher_id = t.id
      JOIN leave_types lt ON lr.leave_type_id = lt.id
      WHERE lr.status = 'approved' AND lr.end_date = CURRENT_DATE
    `;
    
    const { rows } = await pool.query(query);
    
    return res.json({ 
      success: true, 
      count: rows.length,
      results: rows
    });
  } catch (error) {
    console.error('Error fetching leaves ending today:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching leaves' 
    });
  }
});


export default router