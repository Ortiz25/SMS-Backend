import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);


// Get all leave types
router.get('/', authorizeRoles("admin", "librarian", "teacher", "student"),  async (req, res) => {
  try {
    const query = `
      SELECT * FROM leave_types
      WHERE is_active = true
      ORDER BY name
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching leave types:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get leave balances for a teacher
router.get('/balances/:teacherId', authorizeRoles("admin", "librarian", "teacher", "student"),  async (req, res) => {
  try {
    const { teacherId } = req.params;
    
    const query = `
      SELECT 
        lb.id, lb.academic_year, lb.total_days, lb.used_days, lb.remaining_days,
        lt.id AS leave_type_id, lt.name AS leave_type_name, lt.description
      FROM leave_balances lb
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lb.teacher_id = $1
      AND lb.academic_year = '2024-2025' -- Should be dynamic
      ORDER BY lt.name
    `;
    
    const result = await pool.query(query, [teacherId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching leave balances:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router