import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// ======================= DASHBOARD STATS =======================
/**
 * @route GET /api/hostel-transport/stats
 * @desc Get combined hostel and transport statistics
 * @access Private
 */
router.get('/stats', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const stats = {};
    
    // Count total hostelers (students with student_type = 'boarder')
    const hostelersResult = await pool.query(
      "SELECT COUNT(*) FROM students WHERE student_type = 'boarder'"
    );
    stats.hostelers = parseInt(hostelersResult.rows[0].count);
    
    // Count dormitories
    const dormitoriesResult = await pool.query(
      "SELECT COUNT(*) FROM dormitories"
    );
    stats.dormitories = parseInt(dormitoriesResult.rows[0].count);
    
    // Count transport routes
    const routesResult = await pool.query(
      "SELECT COUNT(*) FROM transport_routes WHERE status = 'active'"
    );
    stats.busRoutes = parseInt(routesResult.rows[0].count);
    
    // Count transport users (students with active transport allocations)
    const transportUsersResult = await pool.query(
      "SELECT COUNT(DISTINCT student_id) FROM transport_allocations WHERE status = 'active'"
    );
    stats.transportUsers = parseInt(transportUsersResult.rows[0].count);
    
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error fetching hostel-transport stats:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching statistics'
    });
  }
});

/**
 * @route GET /api/hostel/dormitories
 * @desc Get all dormitories
 * @access Private
 */
router.get('/dormitories', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const dormitoriesResult = await pool.query(
        `SELECT * FROM dormitories ORDER BY name`
      );
      
      res.json({
        success: true,
        dormitories: dormitoriesResult.rows
      });
    } catch (error) {
      console.error('Error fetching dormitories:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching dormitories'
      });
    }
  });
  
  /**
   * @route POST /api/hostel/dormitories
   * @desc Create a new dormitory
   * @access Private (Admin only)
   */
  router.post('/dormitories', authorizeRoles('admin', 'teacher'), async (req, res) => {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only administrators can create dormitories.'
      });
    }
  
    const { name, gender, capacity, fee_per_term, caretaker_name, caretaker_contact } = req.body;
  
    // Validate request
    if (!name || !gender || !capacity || !fee_per_term) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }
  
    try {
      const result = await pool.query(
        `INSERT INTO dormitories 
        (name, gender, capacity, fee_per_term, caretaker_name, caretaker_contact, status) 
        VALUES ($1, $2, $3, $4, $5, $6, $7) 
        RETURNING *`,
        [name, gender, capacity, fee_per_term, caretaker_name, caretaker_contact, 'active']
      );
      
      res.status(201).json({
        success: true,
        dormitory: result.rows[0]
      });
    } catch (error) {
      console.error('Error creating dormitory:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while creating dormitory'
      });
    }
  });
  
  /**
   * @route GET /api/hostel/dormitories/:id
   * @desc Get dormitory by ID
   * @access Private
   */
  router.get('/dormitories/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { id } = req.params;
      
      // Get dormitory details
      const dormitoryResult = await pool.query(
        `SELECT * FROM dormitories WHERE id = $1`,
        [id]
      );
      
      if (dormitoryResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Dormitory not found'
        });
      }
      
      // Get rooms in this dormitory
      const roomsResult = await pool.query(
        `SELECT * FROM dormitory_rooms WHERE dormitory_id = $1 ORDER BY room_number`,
        [id]
      );
      
      res.json({
        success: true,
        dormitory: dormitoryResult.rows[0],
        rooms: roomsResult.rows
      });
    } catch (error) {
      console.error('Error fetching dormitory details:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching dormitory details'
      });
    }
  });
  
  /**
   * @route PUT /api/hostel/dormitories/:id
   * @desc Update a dormitory
   * @access Private (Admin only)
   */
  router.put('/dormitories/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only administrators can update dormitories.'
      });
    }
  
    const { id } = req.params;
    const { name, gender, capacity, fee_per_term, caretaker_name, caretaker_contact, status } = req.body;
  
    try {
      // Check if dormitory exists
      const dormitoryResult = await pool.query(
        `SELECT * FROM dormitories WHERE id = $1`,
        [id]
      );
      
      if (dormitoryResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Dormitory not found'
        });
      }
  
      // Update the dormitory
      const updateResult = await pool.query(
        `UPDATE dormitories 
         SET name = $1, gender = $2, capacity = $3, fee_per_term = $4, 
             caretaker_name = $5, caretaker_contact = $6, status = $7, updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [name, gender, capacity, fee_per_term, caretaker_name, caretaker_contact, status, id]
      );
      
      res.json({
        success: true,
        dormitory: updateResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating dormitory:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while updating dormitory'
      });
    }
  });

  /**
 * @route GET /api/hostel/rooms
 * @desc Get all dormitory rooms
 * @access Private
 */
router.get('/rooms', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const roomsResult = await pool.query(
        `SELECT dr.*, d.name as dormitory_name, d.gender 
         FROM dormitory_rooms dr
         JOIN dormitories d ON dr.dormitory_id = d.id
         ORDER BY d.name, dr.room_number`
      );
      
      res.json({
        success: true,
        rooms: roomsResult.rows
      });
    } catch (error) {
      console.error('Error fetching dormitory rooms:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching dormitory rooms'
      });
    }
  });
  
  /**
   * @route POST /api/hostel/rooms
   * @desc Create a new dormitory room
   * @access Private (Admin only)
   */
  router.post('/rooms', authorizeRoles('admin', 'teacher'), async (req, res) => {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only administrators can create dormitory rooms.'
      });
    }
  
    const { dormitory_id, room_number, capacity } = req.body;
  
    // Validate request
    if (!dormitory_id || !room_number || !capacity) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }
  
    try {
      // Check if the dormitory exists
      const dormitoryResult = await pool.query(
        `SELECT * FROM dormitories WHERE id = $1`,
        [dormitory_id]
      );
      
      if (dormitoryResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Dormitory not found'
        });
      }
      
      // Check if room number already exists in the dormitory
      const existingRoomResult = await pool.query(
        `SELECT * FROM dormitory_rooms 
         WHERE dormitory_id = $1 AND room_number = $2`,
        [dormitory_id, room_number]
      );
      
      if (existingRoomResult.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Room number already exists in this dormitory'
        });
      }
      
      // Create the room
      const result = await pool.query(
        `INSERT INTO dormitory_rooms 
        (dormitory_id, room_number, capacity) 
        VALUES ($1, $2, $3) 
        RETURNING *`,
        [dormitory_id, room_number, capacity]
      );
      
      res.status(201).json({
        success: true,
        room: result.rows[0]
      });
    } catch (error) {
      console.error('Error creating dormitory room:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while creating dormitory room'
      });
    }
  });
  
  /**
   * @route GET /api/hostel/rooms/:id
   * @desc Get room by ID
   * @access Private
   */
  router.get('/rooms/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { id } = req.params;
      
      const roomResult = await pool.query(
        `SELECT dr.*, d.name as dormitory_name, d.gender 
         FROM dormitory_rooms dr
         JOIN dormitories d ON dr.dormitory_id = d.id
         WHERE dr.id = $1`,
        [id]
      );
      
      if (roomResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Room not found'
        });
      }
      
      res.json({
        success: true,
        room: roomResult.rows[0]
      });
    } catch (error) {
      console.error('Error fetching room details:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching room details'
      });
    }
  });
  
  /**
   * @route PUT /api/hostel/rooms/:id
   * @desc Update a dormitory room
   * @access Private (Admin only)
   */
  router.put('/rooms/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only administrators can update dormitory rooms.'
      });
    }
  
    const { id } = req.params;
    const { room_number, capacity } = req.body;
  
    try {
      // Check if room exists
      const roomResult = await pool.query(
        `SELECT * FROM dormitory_rooms WHERE id = $1`,
        [id]
      );
      
      if (roomResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Room not found'
        });
      }
      
      // Check if room number already exists (if being changed)
      if (room_number && room_number !== roomResult.rows[0].room_number) {
        const existingRoomResult = await pool.query(
          `SELECT * FROM dormitory_rooms 
           WHERE dormitory_id = $1 AND room_number = $2 AND id != $3`,
          [roomResult.rows[0].dormitory_id, room_number, id]
        );
        
        if (existingRoomResult.rows.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Room number already exists in this dormitory'
          });
        }
      }
  
      // Update the room
      const updateResult = await pool.query(
        `UPDATE dormitory_rooms 
         SET room_number = $1, capacity = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [
          room_number || roomResult.rows[0].room_number,
          capacity || roomResult.rows[0].capacity,
          id
        ]
      );
      
      res.json({
        success: true,
        room: updateResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating dormitory room:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while updating dormitory room'
      });
    }
  });

  /**
 * @route GET /api/hostel/allocations
 * @desc Get all dormitory allocations
 * @access Private
 */
router.get('/allocations', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      // Get query parameters for filtering
      const { academic_session_id, dormitory_id, status } = req.query;
      
      // Build the query based on filters
      let query = `
        SELECT da.*, 
          s.first_name || ' ' || s.last_name as student_name,
          s.admission_number,
          d.name as dormitory_name,
          dr.room_number,
          a.year || ' Term ' || a.term as academic_session
        FROM dormitory_allocations da
        JOIN students s ON da.student_id = s.id
        JOIN dormitory_rooms dr ON da.room_id = dr.id
        JOIN dormitories d ON dr.dormitory_id = d.id
        JOIN academic_sessions a ON da.academic_session_id = a.id
        WHERE 1=1
      `;
      
      const queryParams = [];
      let paramCount = 1;
      
      if (academic_session_id) {
        query += ` AND da.academic_session_id = $${paramCount}`;
        queryParams.push(academic_session_id);
        paramCount++;
      }
      
      if (dormitory_id) {
        query += ` AND dr.dormitory_id = $${paramCount}`;
        queryParams.push(dormitory_id);
        paramCount++;
      }
      
      if (status) {
        query += ` AND da.status = $${paramCount}`;
        queryParams.push(status);
        paramCount++;
      }
      
      query += ` ORDER BY d.name, dr.room_number, s.last_name, s.first_name`;
      
      const allocationsResult = await pool.query(query, queryParams);
      
      res.json({
        success: true,
        allocations: allocationsResult.rows
      });
    } catch (error) {
      console.error('Error fetching dormitory allocations:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching dormitory allocations'
      });
    }
  });
  
  /**
   * @route POST /api/hostel/allocations
   * @desc Allocate a student to a dormitory room
   * @access Private
   */
  router.post('/allocations', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const { student_id, room_id, bed_number, academic_session_id } = req.body;
  
    // Validate request
    if (!student_id || !room_id || !bed_number || !academic_session_id) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }
  
    try {
      // Start a transaction
      await pool.query('BEGIN');
  
      // Check if student is a boarder
      const studentResult = await pool.query(
        `SELECT * FROM students WHERE id = $1`,
        [student_id]
      );
      
      if (studentResult.rows.length === 0) {
        await pool.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Student not found'
        });
      }
      
      if (studentResult.rows[0].student_type !== 'boarder') {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Student is not registered as a boarder'
        });
      }
      
      // Check if room exists and has capacity
      const roomResult = await pool.query(
        `SELECT dr.*, d.gender as dormitory_gender
         FROM dormitory_rooms dr
         JOIN dormitories d ON dr.dormitory_id = d.id
         WHERE dr.id = $1`,
        [room_id]
      );
      
      if (roomResult.rows.length === 0) {
        await pool.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Room not found'
        });
      }
      
      const room = roomResult.rows[0];
      
      // Check if room has space
      if (room.occupied >= room.capacity) {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Room is at full capacity'
        });
      }
      
      // Check gender matching
      if (
        (room.dormitory_gender === 'boys' && studentResult.rows[0].gender !== 'male') ||
        (room.dormitory_gender === 'girls' && studentResult.rows[0].gender !== 'female')
      ) {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Gender mismatch between student and dormitory'
        });
      }
      
      // Check if bed is already allocated
      const bedCheckResult = await pool.query(
        `SELECT * FROM dormitory_allocations 
         WHERE room_id = $1 AND bed_number = $2 AND academic_session_id = $3 AND status = 'active'`,
        [room_id, bed_number, academic_session_id]
      );
      
      if (bedCheckResult.rows.length > 0) {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'This bed is already allocated to another student'
        });
      }
      
      // Check if student is already allocated somewhere else in the same session
      const studentAllocationResult = await pool.query(
        `SELECT * FROM dormitory_allocations 
         WHERE student_id = $1 AND academic_session_id = $2 AND status = 'active'`,
        [student_id, academic_session_id]
      );
      
      if (studentAllocationResult.rows.length > 0) {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Student is already allocated to a dormitory in this academic session'
        });
      }
      
      // Create the allocation
      const result = await pool.query(
        `INSERT INTO dormitory_allocations 
        (student_id, room_id, bed_number, academic_session_id, allocation_date, status) 
        VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active') 
        RETURNING *`,
        [student_id, room_id, bed_number, academic_session_id]
      );
      
      // Commit the transaction
      await pool.query('COMMIT');
      
      // Get full allocation details for response
      const fullAllocationResult = await pool.query(
        `SELECT da.*, 
          s.first_name || ' ' || s.last_name as student_name,
          s.admission_number,
          d.name as dormitory_name,
          dr.room_number,
          a.year || ' Term ' || a.term as academic_session
        FROM dormitory_allocations da
        JOIN students s ON da.student_id = s.id
        JOIN dormitory_rooms dr ON da.room_id = dr.id
        JOIN dormitories d ON dr.dormitory_id = d.id
        JOIN academic_sessions a ON da.academic_session_id = a.id
        WHERE da.id = $1`,
        [result.rows[0].id]
      );
      
      res.status(201).json({
        success: true,
        allocation: fullAllocationResult.rows[0]
      });
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error('Error creating dormitory allocation:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while creating dormitory allocation'
      });
    }
  });
  
  /**
   * @route PUT /api/hostel/allocations/:id
   * @desc Update dormitory allocation status
   * @access Private
   */
  router.put('/allocations/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const { id } = req.params;
    const { status, vacated_date } = req.body;
  
    try {
      // Check if allocation exists
      const allocationResult = await pool.query(
        `SELECT * FROM dormitory_allocations WHERE id = $1`,
        [id]
      );
      
      if (allocationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Allocation not found'
        });
      }
      
      // Update the allocation
      const updateResult = await pool.query(
        `UPDATE dormitory_allocations 
         SET status = $1, vacated_date = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [status, vacated_date || null, id]
      );
      
      res.json({
        success: true,
        allocation: updateResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating dormitory allocation:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while updating dormitory allocation'
      });
    }
  });
  
  /**
   * @route GET /api/hostel/boarders
   * @desc Get all boarding students
   * @access Private
   */
  router.get('/boarders', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const boardersResult = await pool.query(
        `SELECT s.*, 
          d.name as dormitory,
          da.status as allocation_status
        FROM students s
        LEFT JOIN dormitory_allocations da ON s.id = da.student_id AND da.status = 'active'
        LEFT JOIN dormitory_rooms dr ON da.room_id = dr.id
        LEFT JOIN dormitories d ON dr.dormitory_id = d.id
        WHERE s.student_type = 'boarder'
        ORDER BY s.last_name, s.first_name`
      );
      
      res.json({
        success: true,
        boarders: boardersResult.rows
      });
    } catch (error) {
      console.error('Error fetching boarders:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching boarders'
      });
    }
  });

  router.get('/day-scholars', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const dayScholarsResult = await pool.query(
        `SELECT s.*,
          tr.route_name as transport_route,
          rs.stop_name as pickup_stop,
          ta.status as allocation_status
        FROM students s
        LEFT JOIN transport_allocations ta ON s.id = ta.student_id AND ta.status = 'active'
        LEFT JOIN transport_routes tr ON ta.route_id = tr.id
        LEFT JOIN route_stops rs ON ta.pickup_stop_id = rs.id
        WHERE s.student_type = 'day_scholar'
        ORDER BY s.last_name, s.first_name`
      );
      
      res.json({
        success: true,
        dayScholars: dayScholarsResult.rows
      });
    } catch (error) {
      console.error('Error fetching day scholars:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching day scholars'
      });
    }
  });

  /**
 * @route GET /api/transport/routes
 * @desc Get all transport routes
 * @access Private
 */
router.get('/routes', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const routesResult = await pool.query(
        `SELECT r.*, 
          (SELECT COUNT(*) FROM route_stops WHERE route_id = r.id) as stops_count,
          (SELECT COUNT(*) FROM transport_allocations WHERE route_id = r.id AND status = 'active') as students_count
        FROM transport_routes r
        ORDER BY r.route_name`
      );
      
      res.json({
        success: true,
        routes: routesResult.rows
      });
    } catch (error) {
      console.error('Error fetching transport routes:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching transport routes'
      });
    }
  });
  
  /**
   * @route POST /api/transport/routes
   * @desc Create a new transport route
   * @access Private (Admin only)
   */
  router.post('/routes', authorizeRoles('admin', 'teacher'), async (req, res) => {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only administrators can create transport routes.'
      });
    }
  
    const { route_name, departure_time, return_time, fee_per_term } = req.body;
  
    // Validate request
    if (!route_name || !departure_time || !return_time || !fee_per_term) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }
  
    try {
      const result = await pool.query(
        `INSERT INTO transport_routes 
        (route_name, departure_time, return_time, fee_per_term, status) 
        VALUES ($1, $2, $3, $4, $5) 
        RETURNING *`,
        [route_name, departure_time, return_time, fee_per_term, 'active']
      );
      
      res.status(201).json({
        success: true,
        route: result.rows[0]
      });
    } catch (error) {
      console.error('Error creating transport route:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while creating transport route'
      });
    }
  });
  
  /**
   * @route GET /api/transport/routes/:id
   * @desc Get transport route by ID
   * @access Private
   */
  router.get('/routes/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { id } = req.params;
      
      // Get route details
      const routeResult = await pool.query(
        `SELECT * FROM transport_routes WHERE id = $1`,
        [id]
      );
      
      if (routeResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Transport route not found'
        });
      }
      
      // Get stops on this route
      const stopsResult = await pool.query(
        `SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_order`,
        [id]
      );
      
      res.json({
        success: true,
        route: routeResult.rows[0],
        stops: stopsResult.rows
      });
    } catch (error) {
      console.error('Error fetching transport route details:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching transport route details'
      });
    }
  });
  
  /**
   * @route PUT /api/transport/routes/:id
   * @desc Update a transport route
   * @access Private (Admin only)
   */
  router.put('/routes/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only administrators can update transport routes.'
      });
    }
  
    const { id } = req.params;
    const { route_name, departure_time, return_time, fee_per_term, status } = req.body;
  
    try {
      // Check if route exists
      const routeResult = await pool.query(
        `SELECT * FROM transport_routes WHERE id = $1`,
        [id]
      );
      
      if (routeResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Transport route not found'
        });
      }
  
      // Update the route
      const updateResult = await pool.query(
        `UPDATE transport_routes 
         SET route_name = $1, departure_time = $2, return_time = $3, 
             fee_per_term = $4, status = $5, updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [route_name, departure_time, return_time, fee_per_term, status, id]
      );
      
      res.json({
        success: true,
        route: updateResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating transport route:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while updating transport route'
      });
    }
  });
 /**
 * @route GET /api/transport/stops
 * @desc Get all route stops
 * @access Private
 */
router.get('/stops', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      // Get query parameters for filtering
      const { route_id } = req.query;
      
      let query = `
        SELECT rs.*, tr.route_name 
        FROM route_stops rs
        JOIN transport_routes tr ON rs.route_id = tr.id
        WHERE 1=1
      `;
      
      const queryParams = [];
      
      if (route_id) {
        query += ` AND rs.route_id = $1`;
        queryParams.push(route_id);
      }
      
      query += ` ORDER BY tr.route_name, rs.stop_order`;
      
      const stopsResult = await pool.query(query, queryParams);
      
      res.json({
        success: true,
        stops: stopsResult.rows
      });
    } catch (error) {
      console.error('Error fetching route stops:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching route stops'
      });
    }
  });
  
  /**
   * @route POST /api/transport/stops
   * @desc Create a new route stop
   * @access Private
   */
  router.post('/stops', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const { route_id, stop_name, stop_order, morning_pickup_time, evening_dropoff_time } = req.body;
  
    // Validate request
    if (!route_id || !stop_name || !stop_order) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }
  
    try {
      // Check if the route exists
      const routeResult = await pool.query(
        `SELECT * FROM transport_routes WHERE id = $1`,
        [route_id]
      );
      
      if (routeResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Transport route not found'
        });
      }
      
      // Check if stop name already exists in the route
      const existingStopResult = await pool.query(
        `SELECT * FROM route_stops 
         WHERE route_id = $1 AND stop_name = $2`,
        [route_id, stop_name]
      );
      
      if (existingStopResult.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Stop name already exists in this route'
        });
      }
      
      // Create the stop
      const result = await pool.query(
        `INSERT INTO route_stops 
        (route_id, stop_name, stop_order, morning_pickup_time, evening_dropoff_time) 
        VALUES ($1, $2, $3, $4, $5) 
        RETURNING *`,
        [route_id, stop_name, stop_order, morning_pickup_time, evening_dropoff_time]
      );
      
      // Get full stop details for response
      const fullStopResult = await pool.query(
        `SELECT rs.*, tr.route_name 
         FROM route_stops rs
         JOIN transport_routes tr ON rs.route_id = tr.id
         WHERE rs.id = $1`,
        [result.rows[0].id]
      );
      
      res.status(201).json({
        success: true,
        stop: fullStopResult.rows[0]
      });
    } catch (error) {
      console.error('Error creating route stop:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while creating route stop'
      });
    }
  });
  
  /**
   * @route PUT /api/transport/stops/:id
   * @desc Update a route stop
   * @access Private
   */
  router.put('/stops/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const { id } = req.params;
    const { stop_name, stop_order, morning_pickup_time, evening_dropoff_time } = req.body;
  
    try {
      // Check if stop exists
      const stopResult = await pool.query(
        `SELECT * FROM route_stops WHERE id = $1`,
        [id]
      );
      
      if (stopResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Route stop not found'
        });
      }
  
      // Update the stop
      const updateResult = await pool.query(
        `UPDATE route_stops 
         SET stop_name = $1, stop_order = $2, 
             morning_pickup_time = $3, evening_dropoff_time = $4,
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [stop_name, stop_order, morning_pickup_time, evening_dropoff_time, id]
      );
      
      // Get full stop details for response
      const fullStopResult = await pool.query(
        `SELECT rs.*, tr.route_name 
         FROM route_stops rs
         JOIN transport_routes tr ON rs.route_id = tr.id
         WHERE rs.id = $1`,
        [id]
      );
      
      res.json({
        success: true,
        stop: fullStopResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating route stop:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while updating route stop'
      });
    }
  });
  
  /**
   * @route DELETE /api/transport/stops/:id
   * @desc Delete a route stop
   * @access Private (Admin only)
   */
  router.delete('/stops/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only administrators can delete route stops.'
      });
    }
  
    const { id } = req.params;
  
    try {
      // Check if stop exists
      const stopResult = await pool.query(
        `SELECT * FROM route_stops WHERE id = $1`,
        [id]
      );
      
      if (stopResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Route stop not found'
        });
      }
      
      // Check if any allocations are using this stop as pickup
      const allocationResult = await pool.query(
        `SELECT COUNT(*) FROM transport_allocations 
         WHERE pickup_stop_id = $1 AND status = 'active'`,
        [id]
      );
      
      if (parseInt(allocationResult.rows[0].count) > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete stop. It is currently being used as a pickup point.'
        });
      }
  
      // Delete the stop
      await pool.query(
        `DELETE FROM route_stops WHERE id = $1`,
        [id]
      );
      
      res.json({
        success: true,
        message: 'Route stop deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting route stop:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while deleting route stop'
      });
    }
  });
 /**
 * @route GET /api/transport/allocations
 * @desc Get all transport allocations
 * @access Private
 */
router.get('/transport-allocations', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      // Get query parameters for filtering
      const { academic_session_id, route_id, status } = req.query;
      
      // Build the query based on filters
      let query = `
        SELECT ta.*, 
          s.first_name || ' ' || s.last_name as student_name,
          s.admission_number,
          s.photo_url,
          tr.route_name,
          rs.stop_name,
          a.year || ' Term ' || a.term as academic_session
        FROM transport_allocations ta
        JOIN students s ON ta.student_id = s.id
        JOIN transport_routes tr ON ta.route_id = tr.id
        JOIN route_stops rs ON ta.pickup_stop_id = rs.id
        JOIN academic_sessions a ON ta.academic_session_id = a.id
        WHERE 1=1
      `;
      
      const queryParams = [];
      let paramCount = 1;
      
      if (academic_session_id) {
        query += ` AND ta.academic_session_id = $${paramCount}`;
        queryParams.push(academic_session_id);
        paramCount++;
      }
      
      if (route_id) {
        query += ` AND ta.route_id = $${paramCount}`;
        queryParams.push(route_id);
        paramCount++;
      }
      
      if (status) {
        query += ` AND ta.status = $${paramCount}`;
        queryParams.push(status);
        paramCount++;
      }
      
      query += ` ORDER BY tr.route_name, rs.stop_order, s.last_name, s.first_name`;
      
      const allocationsResult = await pool.query(query, queryParams);
      
      res.json({
        success: true,
        allocations: allocationsResult.rows
      });
    } catch (error) {
      console.error('Error fetching transport allocations:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while fetching transport allocations'
      });
    }
  });
  
  /**
   * @route POST /api/transport/allocations
   * @desc Allocate a student to a transport route
   * @access Private
   */
  router.post('/transport-allocations', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const { student_id, route_id, pickup_stop_id, academic_session_id } = req.body;
  
    // Validate request
    if (!student_id || !route_id || !pickup_stop_id || !academic_session_id) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }
  
    try {
      // Start a transaction
      await pool.query('BEGIN');
  
      // Check if student is a day scholar
      const studentResult = await pool.query(
        `SELECT * FROM students WHERE id = $1`,
        [student_id]
      );
      
      if (studentResult.rows.length === 0) {
        await pool.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Student not found'
        });
      }
      
      if (studentResult.rows[0].student_type !== 'day_scholar') {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Only day scholars can be allocated to transport routes'
        });
      }
      
      // Check if route exists and is active
      const routeResult = await pool.query(
        `SELECT * FROM transport_routes WHERE id = $1`,
        [route_id]
      );
      
      if (routeResult.rows.length === 0) {
        await pool.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Transport route not found'
        });
      }
      
      if (routeResult.rows[0].status !== 'active') {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Transport route is not active'
        });
      }
      
      // Check if pickup stop exists and belongs to the route
      const stopResult = await pool.query(
        `SELECT * FROM route_stops WHERE id = $1 AND route_id = $2`,
        [pickup_stop_id, route_id]
      );
      
      if (stopResult.rows.length === 0) {
        await pool.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Pickup stop not found or does not belong to the selected route'
        });
      }
      
      // Check if student is already allocated to a route in the same session
      const studentAllocationResult = await pool.query(
        `SELECT * FROM transport_allocations 
         WHERE student_id = $1 AND academic_session_id = $2 AND status = 'active'`,
        [student_id, academic_session_id]
      );
      
      if (studentAllocationResult.rows.length > 0) {
        await pool.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          message: 'Student is already allocated to a transport route in this academic session'
        });
      }
      
      // Create the allocation
      const result = await pool.query(
        `INSERT INTO transport_allocations 
        (student_id, route_id, pickup_stop_id, academic_session_id, allocation_date, status) 
        VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active') 
        RETURNING *`,
        [student_id, route_id, pickup_stop_id, academic_session_id]
      );
      
      // Commit the transaction
      await pool.query('COMMIT');
      
      // Get full allocation details for response
      const fullAllocationResult = await pool.query(
        `SELECT ta.*, 
          s.first_name || ' ' || s.last_name as student_name,
          s.admission_number,
          tr.route_name,
          rs.stop_name,
          a.year || ' Term ' || a.term as academic_session
        FROM transport_allocations ta
        JOIN students s ON ta.student_id = s.id
        JOIN transport_routes tr ON ta.route_id = tr.id
        JOIN route_stops rs ON ta.pickup_stop_id = rs.id
        JOIN academic_sessions a ON ta.academic_session_id = a.id
        WHERE ta.id = $1`,
        [result.rows[0].id]
      );
      
      res.status(201).json({
        success: true,
        allocation: fullAllocationResult.rows[0]
      });
    } catch (error) {
      await pool.query('ROLLBACK');
      console.error('Error creating transport allocation:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while creating transport allocation'
      });
    }
  });
  
  /**
   * @route PUT /api/transport/allocations/:id
   * @desc Update transport allocation
   * @access Private
   */
  router.put('/transport-allocations/:id', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const { id } = req.params;
    const { pickup_stop_id, status, end_date } = req.body;
  
    try {
      // Check if allocation exists
      const allocationResult = await pool.query(
        `SELECT * FROM transport_allocations WHERE id = $1`,
        [id]
      );
      
      if (allocationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Allocation not found'
        });
      }
      
      // If pickup stop is being changed, check if it belongs to the route
      if (pickup_stop_id) {
        const stopResult = await pool.query(
          `SELECT * FROM route_stops 
           WHERE id = $1 AND route_id = $2`,
          [pickup_stop_id, allocationResult.rows[0].route_id]
        );
        
        if (stopResult.rows.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Pickup stop does not belong to the allocated route'
          });
        }
      }
      
      // Update the allocation
      const updateResult = await pool.query(
        `UPDATE transport_allocations 
         SET pickup_stop_id = $1, status = $2, end_date = $3, updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [
          pickup_stop_id || allocationResult.rows[0].pickup_stop_id, 
          status || allocationResult.rows[0].status, 
          end_date || allocationResult.rows[0].end_date, 
          id
        ]
      );
      
      // Get full allocation details for response
      const fullAllocationResult = await pool.query(
        `SELECT ta.*, 
          s.first_name || ' ' || s.last_name as student_name,
          s.admission_number,
          tr.route_name,
          rs.stop_name,
          a.year || ' Term ' || a.term as academic_session
        FROM transport_allocations ta
        JOIN students s ON ta.student_id = s.id
        JOIN transport_routes tr ON ta.route_id = tr.id
        JOIN route_stops rs ON ta.pickup_stop_id = rs.id
        JOIN academic_sessions a ON ta.academic_session_id = a.id
        WHERE ta.id = $1`,
        [id]
      );
      
      res.json({
        success: true,
        allocation: fullAllocationResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating transport allocation:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while updating transport allocation'
      });
    }
  });  

export default router