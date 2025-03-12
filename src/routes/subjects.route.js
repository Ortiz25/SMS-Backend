// src/routes/academic.routes.js
import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';


const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);


// Get subjects by IDs (for teacher specialization)
// Get subjects by teacher specialization
router.get('/subjects', async (req, res) => {
  try {
    const { teacher_id, specialization, level, curriculum_type } = req.query;
    
    // If level and curriculum_type are provided, filter subjects by these criteria
    if (level && curriculum_type) {
      const levelSubjectsQuery = `
        SELECT id, name, code, curriculum_type, level, department_id
        FROM subjects
        WHERE (level = $1 OR level = 'all')
        AND curriculum_type = $2
        ORDER BY name
      `;
      
      const levelSubjectsResult = await pool.query(levelSubjectsQuery, [level, curriculum_type]);
      
      return res.json({
        success: true,
        message: `Subjects for ${level} (${curriculum_type}) fetched successfully`,
        data: levelSubjectsResult.rows
      });
    }
    // If we have a teacher ID, get subjects based on their specialization
    else if (teacher_id) {
      const teacherQuery = `
        SELECT subject_specialization
        FROM teachers
        WHERE id = $1
      `;
     
      const teacherResult = await pool.query(teacherQuery, [teacher_id]);
     
      if (teacherResult.rows.length === 0) {
        return res.status(404).json({ 
          success: false,
          message: 'Teacher not found' 
        });
      }
     
      // Get the specialization array from the teacher record
      const specializations = teacherResult.rows[0].subject_specialization || [];
     
      // Now fetch subjects that match these specializations
      const subjectsQuery = `
        SELECT id, name, code, curriculum_type, level, department_id
        FROM subjects
        WHERE name = ANY($1::text[])
        OR code = ANY($1::text[])
        ORDER BY name
      `;
     
      const subjectsResult = await pool.query(subjectsQuery, [specializations]);
      
      return res.json({
        success: true,
        message: 'Teacher specialized subjects fetched successfully',
        data: subjectsResult.rows
      });
    }
    // If specialization query parameter is provided directly
    else if (specialization) {
      // Parse specialization parameter as comma-separated string
      const specializationArray = specialization.split(',').map(s => s.trim());
     
      const subjectsByNameQuery = `
        SELECT id, name, code, curriculum_type, level, department_id
        FROM subjects
        WHERE name = ANY($1::text[])
        OR code = ANY($1::text[])
        ORDER BY name
      `;
     
      const subjectsResult = await pool.query(subjectsByNameQuery, [specializationArray]);
      
      return res.json({
        success: true,
        message: 'Specialized subjects fetched successfully',
        data: subjectsResult.rows
      });
    }
    // Otherwise return all subjects
    else {
      const allSubjectsQuery = `
        SELECT id, name, code, curriculum_type, level, department_id
        FROM subjects
        ORDER BY name
      `;
     
      const allResult = await pool.query(allSubjectsQuery);
      
      return res.json({
        success: true,
        message: 'All subjects fetched successfully',
        data: allResult.rows
      });
    }
  } catch (error) {
    console.error('Error fetching subjects:', error);
    
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});
  
// Get class by ID with details
router.get('/:id', async (req, res, next) => {
    try {
        const result = await classModel.getClassDetails(req.params.id);
        if (!result.rows.length) {
            return res.status(404).json({ error: 'Class not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

// Assign teacher to subject
router.post('/teacher-subjects', async (req, res) => {
    try {
      const { teacher_id, subject_id, class_id, academic_session_id } = req.body;
      
      // Validate required fields
      if (!teacher_id || !subject_id || !class_id || !academic_session_id) {
        return res.status(400).json({ 
          message: 'Missing required fields',
          required: ['teacher_id', 'subject_id', 'class_id', 'academic_session_id']
        });
      }
      
      // Check if assignment already exists
      const checkQuery = `
        SELECT id FROM teacher_subjects
        WHERE teacher_id = $1 
          AND subject_id = $2 
          AND class_id = $3 
          AND academic_session_id = $4
      `;
      
      const checkResult = await pool.query(checkQuery, [
        teacher_id, subject_id, class_id, academic_session_id
      ]);
      
      if (checkResult.rows.length > 0) {
        return res.status(409).json({ 
          message: 'Teacher is already assigned to this subject for this class',
          id: checkResult.rows[0].id
        });
      }
      
      // Insert new assignment
      const insertQuery = `
        INSERT INTO teacher_subjects 
          (teacher_id, subject_id, class_id, academic_session_id, created_at)
        VALUES 
          ($1, $2, $3, $4, NOW())
        RETURNING id, teacher_id, subject_id, class_id, academic_session_id, created_at
      `;
      
      const result = await pool.query(insertQuery, [
        teacher_id, subject_id, class_id, academic_session_id
      ]);
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Error assigning teacher to subject:', error);
      
      // Check for uniqueness constraint violation
      if (error.code === '23505') {
        return res.status(409).json({ 
          message: 'Teacher is already assigned to this subject for this class' 
        });
      }
      
      res.status(500).json({ message: 'Server error' });
    }
  });

export default router