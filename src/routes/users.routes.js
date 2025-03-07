import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import bcrypt from "bcryptjs";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);


// Get all users
router.get('/', authorizeRoles('admin'),async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, role, is_active, last_login, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get a specific user
router.get('/:id', authorizeRoles('admin'),async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, username, email, role, is_active, last_login, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Create a new user
router.post('/',authorizeRoles('admin'), async (req, res) => {
  try {
    const { username, email, password, role, is_active } = req.body;
    
    // Validate input
    if (!username || !email || !password || !role) {
      return res.status(400).json({ error: 'Required fields are missing' });
    }
    
    // Check if username or email already exists
    const existingUser = await pool.query(
      'SELECT * FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    
    // Hash the password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Insert the new user
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, email, role, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, email, role, is_active, created_at',
      [username, passwordHash, email, role, is_active]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update a user
router.put('/:id',authorizeRoles('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, password, role, is_active } = req.body;
    
    // Check if user exists
    const userCheck = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if username or email already exists for other users
    if (username || email) {
      const existingUser = await pool.query(
        'SELECT * FROM users WHERE (username = $1 OR email = $2) AND id != $3',
        [username || '', email || '', id]
      );
      
      if (existingUser.rows.length > 0) {
        return res.status(409).json({ error: 'Username or email already exists' });
      }
    }
    
    // Prepare update fields and values
    let updateFields = [];
    let values = [];
    let valueIndex = 1;
    
    if (username) {
      updateFields.push(`username = $${valueIndex}`);
      values.push(username);
      valueIndex++;
    }
    
    if (email) {
      updateFields.push(`email = $${valueIndex}`);
      values.push(email);
      valueIndex++;
    }
    
    if (password) {
      // Hash the new password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      updateFields.push(`password_hash = $${valueIndex}`);
      values.push(passwordHash);
      valueIndex++;
    }
    
    if (role) {
      updateFields.push(`role = $${valueIndex}`);
      values.push(role);
      valueIndex++;
    }
    
    if (is_active !== undefined) {
      updateFields.push(`is_active = $${valueIndex}`);
      values.push(is_active);
      valueIndex++;
    }
    
    // Add updated_at timestamp
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    
    // If no fields to update
    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    // Add the id as the last parameter
    values.push(id);
    
    // Update the user
    const result = await pool.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${valueIndex} RETURNING id, username, email, role, is_active, updated_at`,
      values
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Delete a user
router.delete('/:id',authorizeRoles('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user exists
    const userCheck = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Delete the user
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router