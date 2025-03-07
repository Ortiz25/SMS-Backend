
import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// Get all hostels
router.get('/', authorizeRoles('admin', 'teacher', 'staff'), async (req, res, next) => {
    try {
        const query = `
            SELECT
                d.id,
                d.name,
                d.gender as hostel_type, 
                d.capacity,
                d.occupied,
                d.fee_per_term,
                d.caretaker_name,
                d.caretaker_contact as caretaker_phone,
                d.status,
                (d.capacity - d.occupied) as available_slots
            FROM
                dormitories d
            WHERE
                d.status = 'active'
            ORDER BY
                d.name
        `;
       
        const result = await pool.query(query);
       
        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching dormitories:', error);
        next(error);
    }
});

// Get hostel by ID
router.get('/:id', authorizeRoles('admin', 'teacher', 'staff'), async (req, res, next) => {
    try {
        const hostelId = req.params.id;
        
        const query = `
            SELECT 
                h.*,
                (h.capacity - h.occupied) as available_slots
            FROM 
                hostels h
            WHERE 
                h.id = $1
        `;
        
        const result = await pool.query(query, [hostelId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Hostel not found'
            });
        }
        
        // Get current students in this hostel
        const studentsQuery = `
            SELECT 
                s.id,
                s.admission_number,
                s.first_name || ' ' || s.last_name as name,
                s.gender,
                c.name as class,
                s.stream,
                ha.room_number,
                ha.bed_number,
                ha.allocation_date
            FROM 
                hostel_allocations ha
            JOIN 
                students s ON ha.student_id = s.id
            LEFT JOIN 
                classes c ON s.current_class = c.id::text
            WHERE 
                ha.hostel_id = $1
                AND ha.status = 'active'
            ORDER BY 
                c.name, s.stream, s.admission_number
        `;
        
        const studentsResult = await pool.query(studentsQuery, [hostelId]);
        
        res.json({
            success: true,
            data: {
                ...result.rows[0],
                students: studentsResult.rows
            }
        });
    } catch (error) {
        console.error(`Error fetching hostel with ID ${req.params.id}:`, error);
        next(error);
    }
});



export default router;