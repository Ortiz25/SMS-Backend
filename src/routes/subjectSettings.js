import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { check, validationResult } from "express-validator"
const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

/**
 * Route Ordering Fix: Specific routes before parameter routes
 * Place these specific routes first, before the /:id routes
 */

/**
 * @route   GET /api/subjects/by-curriculum/:type
 * @desc    Get subjects by curriculum type
 * @access  Private
 */
router.get('/by-curriculum/:type', authorizeRoles('admin'), async (req, res) => {
  try {
    const { type } = req.params;
    
    if (type !== 'CBC' && type !== '844') {
      return res.status(400).json({ message: 'Invalid curriculum type' });
    }

    const subjects = await pool.query(
      'SELECT * FROM subjects WHERE curriculum_type = $1 ORDER BY name ASC',
      [type]
    );
    
    res.json(subjects.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/subjects/by-level/:level
 * @desc    Get subjects by education level
 * @access  Private
 */
router.get('/by-level/:level', authorizeRoles('admin'), async (req, res) => {
  try {
    const { level } = req.params;
    const subjects = await pool.query(
      'SELECT * FROM subjects WHERE level = $1 ORDER BY name ASC',
      [level]
    );
    
    res.json(subjects.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/subjects/by-department/:id
 * @desc    Get subjects by department ID
 * @access  Private
 */
router.get('/by-department/:id', authorizeRoles('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    // Fix: Parse ID as integer
    const departmentId = parseInt(id, 10);
    
    if (isNaN(departmentId)) {
      return res.status(400).json({ message: 'Invalid department ID format' });
    }
    
    const subjects = await pool.query(
      'SELECT * FROM subjects WHERE department_id = $1 ORDER BY name ASC',
      [departmentId]
    );
    
    res.json(subjects.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

router.get('/departments',authorizeRoles('admin'), async (req, res) => {
    try {
      const departments = await pool.query(
        'SELECT * FROM departments ORDER BY name ASC'
      );
      res.json(departments.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });

/**
 * @route   GET /api/subjects
 * @desc    Get all subjects
 * @access  Private
 */
router.get('/', authorizeRoles('admin'), async (req, res) => {
  try {
    const subjects = await pool.query(
      'SELECT * FROM subjects ORDER BY name ASC'
    );
    res.json(subjects.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   POST /api/subjects
 * @desc    Create a new subject
 * @access  Private (Admin only)
 */
router.post('/', [
  authorizeRoles('admin'),
  check('name', 'Subject name is required').not().isEmpty(),
  check('code', 'Subject code is required').not().isEmpty(),
  check('curriculum_type', 'Curriculum type is required').isIn(['CBC', '844']),
  check('department_id', 'Department ID is required').isInt(),
  check('level', 'Education level is required').not().isEmpty(),
  check('passing_marks', 'Passing marks must be a number between 0 and 100').isFloat({ min: 0, max: 100 })
], async (req, res) => {
  // Validate request
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, code, curriculum_type, department_id, level, passing_marks } = req.body;
  
  // Fix: Ensure values are properly typed for database
  const departmentId = parseInt(department_id, 10);
  const passingMarks = parseFloat(passing_marks);
  
  // Additional validation
  if (isNaN(departmentId)) {
    return res.status(400).json({ message: 'Invalid department ID format' });
  }

  try {
    // Check if subject code already exists
    const existingSubject = await pool.query(
      'SELECT * FROM subjects WHERE code = $1',
      [code]
    );

    if (existingSubject.rows.length > 0) {
      return res.status(400).json({ message: 'Subject code already exists' });
    }

    // Create new subject
    const newSubject = await pool.query(
      `INSERT INTO subjects (name, code, curriculum_type, department_id, level, passing_marks)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, code, curriculum_type, departmentId, level, passingMarks]
    );

    res.status(201).json(newSubject.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/subjects/:id
 * @desc    Get a subject by ID
 * @access  Private
 */
router.get('/:id', authorizeRoles('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    // Fix: Parse ID as integer
    const subjectId = parseInt(id, 10);
    
    if (isNaN(subjectId)) {
      return res.status(400).json({ message: 'Invalid subject ID format' });
    }
    
    const subject = await pool.query(
      'SELECT * FROM subjects WHERE id = $1',
      [subjectId]
    );

    if (subject.rows.length === 0) {
      return res.status(404).json({ message: 'Subject not found' });
    }

    res.json(subject.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   PUT /api/subjects/:id
 * @desc    Update a subject
 * @access  Private (Admin only)
 */
router.put('/:id', [
  authorizeRoles('admin'),
  check('name', 'Subject name is required').not().isEmpty(),
  check('code', 'Subject code is required').not().isEmpty(),
  check('curriculum_type', 'Curriculum type is required').isIn(['CBC', '844']),
  check('department_id', 'Department ID is required').isInt(),
  check('level', 'Education level is required').not().isEmpty(),
  check('passing_marks', 'Passing marks must be a number between 0 and 100').isFloat({ min: 0, max: 100 })
], async (req, res) => {
  // Validate request
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id } = req.params;
  const { name, code, curriculum_type, department_id, level, passing_marks } = req.body;
  
  // Fix: Ensure values are properly typed for database
  const subjectId = parseInt(id, 10);
  const departmentId = parseInt(department_id, 10);
  const passingMarks = parseFloat(passing_marks);
  
  // Additional validation
  if (isNaN(subjectId) || isNaN(departmentId)) {
    return res.status(400).json({ message: 'Invalid ID format' });
  }

  try {
    // Check if subject exists
    const existingSubject = await pool.query(
      'SELECT * FROM subjects WHERE id = $1',
      [subjectId]
    );

    if (existingSubject.rows.length === 0) {
      return res.status(404).json({ message: 'Subject not found' });
    }

    // Check if the updated code conflicts with another subject
    const codeCheck = await pool.query(
      'SELECT * FROM subjects WHERE code = $1 AND id != $2',
      [code, subjectId]
    );

    if (codeCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Subject code already exists' });
    }

    // Update subject
    const updatedSubject = await pool.query(
      `UPDATE subjects 
       SET name = $1, code = $2, curriculum_type = $3, department_id = $4, level = $5, passing_marks = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [name, code, curriculum_type, departmentId, level, passingMarks, subjectId]
    );

    res.json(updatedSubject.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   DELETE /api/subjects/:id
 * @desc    Delete a subject
 * @access  Private (Admin only)
 */
router.delete('/:id', authorizeRoles('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    // Fix: Parse ID as integer
    const subjectId = parseInt(id, 10);
    
    if (isNaN(subjectId)) {
      return res.status(400).json({ message: 'Invalid subject ID format' });
    }

    // Check if subject exists
    const subject = await pool.query(
      'SELECT * FROM subjects WHERE id = $1',
      [subjectId]
    );

    if (subject.rows.length === 0) {
      return res.status(404).json({ message: 'Subject not found' });
    }

    // Check if subject is being used in student_subjects, teacher_subjects, or exam_schedules
    const usageCheck = await pool.query(
      `SELECT 
        (SELECT COUNT(*) FROM student_subjects WHERE subject_id = $1) as student_count,
        (SELECT COUNT(*) FROM teacher_subjects WHERE subject_id = $1) as teacher_count,
        (SELECT COUNT(*) FROM exam_schedules WHERE subject_id = $1) as exam_count`,
      [subjectId]
    );

    const { student_count, teacher_count, exam_count } = usageCheck.rows[0];
    
    if (parseInt(student_count) > 0 || parseInt(teacher_count) > 0 || parseInt(exam_count) > 0) {
      return res.status(400).json({ 
        message: 'Unable to delete subject as it is being used in student enrollments, teacher assignments, or exam schedules' 
      });
    }

    // Delete subject
    await pool.query('DELETE FROM subjects WHERE id = $1', [subjectId]);
    res.json({ message: 'Subject deleted successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

export default router;