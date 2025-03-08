import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// Apply authentication middleware
/**
 * @route   GET /api/finance/payments
 * @desc    Get all payments with pagination and filtering
 * @access  Private (admin, accountant)
 */
router.get('/payments', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    // Extract query parameters
    const { 
      page = 1, 
      limit = 20, 
      paymentMethod, 
      status, 
      startDate, 
      endDate, 
      academicSession,
      search 
    } = req.query;
    
    const offset = (page - 1) * limit;
    const params = [];
    let queryConditions = [];
    let queryParams = 1;
    
    // Build query conditions based on filters
    if (paymentMethod) {
      queryConditions.push(`payment_method = $${queryParams++}`);
      params.push(paymentMethod);
    }
    
    if (status) {
      queryConditions.push(`payment_status = $${queryParams++}`);
      params.push(status);
    }
    
    if (academicSession) {
      queryConditions.push(`academic_session_id = $${queryParams++}`);
      params.push(academicSession);
    }
    
    if (startDate) {
      queryConditions.push(`payment_date >= $${queryParams++}`);
      params.push(startDate);
    }
    
    if (endDate) {
      queryConditions.push(`payment_date <= $${queryParams++}`);
      params.push(endDate);
    }
    
    if (search) {
      queryConditions.push(`(
        admission_number ILIKE $${queryParams} OR
        receipt_number ILIKE $${queryParams} OR
        transaction_reference ILIKE $${queryParams} OR
        mpesa_code ILIKE $${queryParams}
      )`);
      params.push(`%${search}%`);
      queryParams++;
    }
    
    const whereClause = queryConditions.length ? `WHERE ${queryConditions.join(' AND ')}` : '';
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) 
      FROM fee_payments 
      ${whereClause}
    `;
    
    const countResult = await pool.query(countQuery, params);
    const totalCount = parseInt(countResult.rows[0].count);
    
    // Get paginated payments with student info
    const query = `
      SELECT 
        p.*,
        s.first_name,
        s.last_name,
        s.current_class,
        s.stream,
        a.year,
        a.term
      FROM fee_payments p
      JOIN students s ON p.admission_number = s.admission_number
      JOIN academic_sessions a ON p.academic_session_id = a.id
      ${whereClause}
      ORDER BY p.payment_date DESC, p.id DESC
      LIMIT $${queryParams++} OFFSET $${queryParams}
    `;
    
    params.push(parseInt(limit));
    params.push(offset);
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      count: totalCount,
      pages: Math.ceil(totalCount / limit),
      currentPage: parseInt(page),
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * @route   GET /api/finance/payments/:id
 * @desc    Get single payment by ID
 * @access  Private (admin, accountant)
 */
router.get('/payments/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        p.*,
        s.first_name,
        s.last_name,
        s.current_class,
        s.stream,
        s.student_type,
        a.year,
        a.term
      FROM fee_payments p
      JOIN students s ON p.admission_number = s.admission_number
      JOIN academic_sessions a ON p.academic_session_id = a.id
      WHERE p.id = $1
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * @route   GET /api/finance/student-payments/:admissionNumber
 * @desc    Get all payments for a specific student
 * @access  Private (admin, accountant, teacher, parent of the student)
 */
router.get('/student-payments/:admissionNumber', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { academicSessionId } = req.query;
    
    // For parent users, verify they are authorized to see this student
    if (req.user.role === 'parent') {
      const parentCheckQuery = `
        SELECT 1 FROM student_parent_relationships spr
        JOIN parents p ON spr.parent_id = p.id
        JOIN students s ON spr.student_id = s.id
        WHERE s.admission_number = $1 AND p.user_id = $2
      `;
      
      const parentCheck = await pool.query(parentCheckQuery, [admissionNumber, req.user.id]);
      
      if (parentCheck.rows.length === 0) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this student data' });
      }
    }
    
    let query = `
      SELECT 
        p.*,
        a.year,
        a.term
      FROM fee_payments p
      JOIN academic_sessions a ON p.academic_session_id = a.id
      WHERE p.admission_number = $1
    `;
    
    const params = [admissionNumber];
    
    if (academicSessionId) {
      query += ` AND p.academic_session_id = $2`;
      params.push(academicSessionId);
    }
    
    query += ` ORDER BY p.payment_date DESC, p.id DESC`;
    
    const result = await pool.query(query, params);
    
    // Get student info
    const studentQuery = `
      SELECT 
        s.admission_number,
        s.first_name,
        s.last_name,
        s.current_class,
        s.stream,
        s.student_type
      FROM students s
      WHERE s.admission_number = $1
    `;
    
    const studentResult = await pool.query(studentQuery, [admissionNumber]);
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    res.json({
      success: true,
      student: studentResult.rows[0],
      payments: result.rows
    });
  } catch (error) {
    console.error('Error fetching student payments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * @route   GET /api/finance/stats
 * @desc    Get payment statistics
 * @access  Private (admin, accountant)
 */
router.get('/stats', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { academicSessionId } = req.query;
    
    let sessionFilter = '';
    const params = [];
    
    if (academicSessionId) {
      sessionFilter = 'WHERE p.academic_session_id = $1';
      params.push(academicSessionId);
    }
    
    // Payment method totals
    const paymentMethodQuery = `
      SELECT 
        payment_method,
        COUNT(*) as count,
        SUM(amount) as total_amount
      FROM fee_payments p
      ${sessionFilter}
      GROUP BY payment_method
    `;
    
    // Monthly payments
    const monthlyQuery = `
      SELECT 
        TO_CHAR(payment_date, 'Mon') as month,
        EXTRACT(MONTH FROM payment_date) as month_num,
        payment_method,
        SUM(amount) as total_amount
      FROM fee_payments p
      ${sessionFilter}
      GROUP BY TO_CHAR(payment_date, 'Mon'), EXTRACT(MONTH FROM payment_date), payment_method
      ORDER BY month_num
    `;
    
    // Payment status summary
    const statusQuery = `
      SELECT 
        payment_status,
        COUNT(*) as count,
        SUM(amount) as total_amount
      FROM fee_payments p
      ${sessionFilter}
      GROUP BY payment_status
    `;
    
    // Current session total
    const currentSessionQuery = `
      SELECT 
        SUM(amount) as total_amount
      FROM fee_payments p
      WHERE payment_status = 'success'
      ${academicSessionId ? 'AND p.academic_session_id = $1' : 'AND p.academic_session_id = (SELECT id FROM academic_sessions WHERE is_current = true)'}
    `;
    
    const paymentMethodResults = await pool.query(paymentMethodQuery, [...params]);
    const monthlyResults = await pool.query(monthlyQuery, [...params]);
    const statusResults = await pool.query(statusQuery, [...params]);
    const currentSessionResults = await pool.query(currentSessionQuery, academicSessionId ? [...params] : []);
    
    // Format data for frontend charts
    const monthlyData = {};
    monthlyResults.rows.forEach(row => {
      if (!monthlyData[row.month]) {
        monthlyData[row.month] = {
          month: row.month,
          mpesa: 0,
          bank: 0,
          cash: 0,
          cheque: 0,
          total: 0
        };
      }
      
      monthlyData[row.month][row.payment_method] = parseFloat(row.total_amount);
      monthlyData[row.month].total += parseFloat(row.total_amount);
    });
    
    res.json({
      success: true,
      data: {
        paymentMethods: paymentMethodResults.rows,
        monthly: Object.values(monthlyData),
        status: statusResults.rows,
        currentSessionTotal: currentSessionResults.rows[0]?.total_amount || 0
      }
    });
  } catch (error) {
    console.error('Error fetching payment stats:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * @route   POST /api/finance/payments
 * @desc    Create new payment
 * @access  Private (admin, accountant)
 */
router.post('/payments', authorizeRoles('admin', 'teacher'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      admissionNumber,
      amount,
      paymentDate,
      academicSessionId,
      paymentMethod,
      transactionReference,
      mpesaCode,
      mpesaPhone,
      bankName,
      bankBranch,
      notes
    } = req.body;
    
    // Validate required fields
    if (!admissionNumber || !amount || !paymentDate || !academicSessionId || !paymentMethod) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // Validate payment method specific fields
    if (paymentMethod === 'mpesa' && !mpesaCode) {
      return res.status(400).json({ success: false, message: 'M-Pesa code is required for M-Pesa payments' });
    }
    
    if (paymentMethod === 'bank' && !bankName) {
      return res.status(400).json({ success: false, message: 'Bank name is required for bank payments' });
    }
    
    // Verify student exists
    const studentCheck = await client.query(
      'SELECT id FROM students WHERE admission_number = $1',
      [admissionNumber]
    );
    
    if (studentCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    // Generate receipt number
    const receiptPrefix = paymentMethod === 'mpesa' ? 'RCT-MP-' : 
                          paymentMethod === 'bank' ? 'RCT-BK-' : 
                          paymentMethod === 'cash' ? 'RCT-CS-' : 'RCT-CQ-';
    
    const lastReceiptQuery = await client.query(
      `SELECT receipt_number FROM fee_payments 
       WHERE receipt_number LIKE $1 
       ORDER BY receipt_number DESC LIMIT 1`,
      [`${receiptPrefix}%`]
    );
    
    let receiptNumber;
    if (lastReceiptQuery.rows.length > 0) {
      const lastNumber = parseInt(lastReceiptQuery.rows[0].receipt_number.split('-')[2]);
      receiptNumber = `${receiptPrefix}${(lastNumber + 1).toString().padStart(3, '0')}`;
    } else {
      receiptNumber = `${receiptPrefix}001`;
    }
    
    // Insert the payment
    const insertQuery = `
      INSERT INTO fee_payments (
        admission_number, 
        amount, 
        payment_date, 
        academic_session_id, 
        payment_method, 
        receipt_number, 
        transaction_reference, 
        payment_status, 
        received_by, 
        notes, 
        mpesa_code, 
        mpesa_phone, 
        bank_name, 
        bank_branch
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;
    
    const result = await client.query(insertQuery, [
      admissionNumber,
      amount,
      paymentDate,
      academicSessionId,
      paymentMethod,
      receiptNumber,
      transactionReference || null,
      'success',
      req.user.id,
      notes || null,
      mpesaCode || null,
      mpesaPhone || null,
      bankName || null,
      bankBranch || null
    ]);
    
    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      data: result.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating payment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    client.release();
  }
});

/**
 * @route   GET /api/finance/academic-sessions
 * @desc    Get all academic sessions for filtering
 * @access  Private
 */
router.get('/academic-sessions', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const query = `
      SELECT id, year, term, is_current, status
      FROM academic_sessions
      ORDER BY year DESC, term DESC
    `;
    
    const result = await pool.query(query);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching academic sessions:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;