import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

/**
 * DASHBOARD & STATISTICS ROUTES
 */

// Get inventory statistics
router.get('/inventory/stats',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const client = await pool.connect();
    
    // Get asset statistics
    const totalAssetsResult = await client.query('SELECT COUNT(*) FROM assets WHERE status != \'disposed\'');
    const maintenanceResult = await client.query('SELECT COUNT(*) FROM assets WHERE status = \'maintenance\'');
    
    // Get low stock items
    const lowStockResult = await client.query(
      'SELECT COUNT(*) FROM inventory_items WHERE current_quantity <= min_quantity'
    );
    
    client.release();
    
    res.json({
      totalAssets: parseInt(totalAssetsResult.rows[0].count),
      maintenanceRequired: parseInt(maintenanceResult.rows[0].count),
      lowStockItems: parseInt(lowStockResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching inventory stats:', error);
    res.status(500).json({ error: 'Failed to retrieve inventory statistics' });
  }
});

// Get departments for asset management
router.get('/departments', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM departments ORDER BY name ASC');
      res.json(rows);
    } catch (error) {
      console.error('Error fetching departments:', error);
      res.status(500).json({ error: 'Failed to retrieve departments' });
    }
  });

  // Get rooms for asset management
router.get('/rooms', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM rooms ORDER BY room_number ASC');
      res.json(rows);
    } catch (error) {
      console.error('Error fetching rooms:', error);
      res.status(500).json({ error: 'Failed to retrieve rooms' });
    }
  });

  // Get maintenance records for an asset
router.get('/assets/:id/maintenance', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query(
        `SELECT * FROM asset_maintenance
         WHERE asset_id = $1
         ORDER BY maintenance_date DESC`,
        [id]
      );
      res.json(rows);
    } catch (error) {
      console.error('Error fetching asset maintenance records:', error);
      res.status(500).json({ error: 'Failed to retrieve maintenance records' });
    }
  });

  // Get transaction history for an inventory item
router.get('/inventory/:id/transactions', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query(
        `SELECT t.*, u.username as performed_by_name, d.name as department_name
         FROM inventory_transactions t
         LEFT JOIN users u ON t.performed_by = u.id
         LEFT JOIN departments d ON t.department_id = d.id
         WHERE t.item_id = $1
         ORDER BY t.transaction_date DESC`,
        [id]
      );
      res.json(rows);
    } catch (error) {
      console.error('Error fetching inventory transactions:', error);
      res.status(500).json({ error: 'Failed to retrieve transactions' });
    }
  });

/**
 * ASSETS ROUTES
 */

// Get all assets with optional filtering
router.get('/assets', authorizeRoles('admin', 'teacher', 'staff'),async (req, res) => {
  try {
    const { search, category } = req.query;
    console.log("reached")
    let query = `
      SELECT a.*, ac.name as category
      FROM assets a
      LEFT JOIN asset_categories ac ON a.category_id = ac.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    if (search) {
      queryParams.push(`%${search}%`);
      query += ` AND (a.name ILIKE $${queryParams.length} 
                OR a.asset_id ILIKE $${queryParams.length} 
                OR a.location ILIKE $${queryParams.length})`;
    }
    
    if (category && category !== 'all') {
      queryParams.push(`%${category}%`);
      query += ` AND ac.name ILIKE $${queryParams.length}`;
    }
    
    query += ' ORDER BY a.created_at DESC';
    
    const { rows } = await pool.query(query, queryParams);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching assets:', error);
    res.status(500).json({ error: 'Failed to retrieve assets' });
  }
});

// Get a single asset by ID
router.get('/assets/:id', authorizeRoles('admin', 'teacher', 'staff'),async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT a.*, ac.name as category
       FROM assets a
       LEFT JOIN asset_categories ac ON a.category_id = ac.id
       WHERE a.id = $1`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching asset:', error);
    res.status(500).json({ error: 'Failed to retrieve asset' });
  }
});

// Create a new asset
router.post('/assets',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      asset_id,
      name,
      category_id,
      location,
      purchase_date,
      purchase_cost,
      supplier,
      warranty_expiry,
      status,
      assigned_to,
      department_id,
      room_id,
      notes
    } = req.body;
    
    // Check if asset_id already exists
    const checkResult = await client.query(
      'SELECT id FROM assets WHERE asset_id = $1',
      [asset_id]
    );
    
    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Asset ID already exists' });
    }
    
    const result = await client.query(
      `INSERT INTO assets (
        asset_id, name, category_id, location, purchase_date,
        purchase_cost, supplier, warranty_expiry, status,
        assigned_to, department_id, room_id, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        asset_id, name, category_id, location, purchase_date,
        purchase_cost, supplier, warranty_expiry, status || 'active',
        assigned_to, department_id, room_id, notes
      ]
    );
    
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating asset:', error);
    res.status(500).json({ error: 'Failed to create asset' });
  } finally {
    client.release();
  }
});

// Update an asset
router.patch('/assets/:id',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      name,
      category_id,
      location,
      purchase_date,
      purchase_cost,
      supplier,
      warranty_expiry,
      status,
      assigned_to,
      department_id,
      room_id,
      notes,
      last_maintenance_date,
      next_maintenance_date
    } = req.body;
    
    // Check if asset exists
    const checkResult = await client.query('SELECT id FROM assets WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    // Build dynamic update query
    let updateQuery = 'UPDATE assets SET ';
    let queryParams = [];
    let paramIndex = 1;
    let updates = [];
    
    // Add fields if they exist in the request body
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      queryParams.push(name);
    }
    
    if (category_id !== undefined) {
      updates.push(`category_id = $${paramIndex++}`);
      queryParams.push(category_id);
    }
    
    if (location !== undefined) {
      updates.push(`location = $${paramIndex++}`);
      queryParams.push(location);
    }
    
    if (purchase_date !== undefined) {
      updates.push(`purchase_date = $${paramIndex++}`);
      queryParams.push(purchase_date);
    }
    
    if (purchase_cost !== undefined) {
      updates.push(`purchase_cost = $${paramIndex++}`);
      queryParams.push(purchase_cost);
    }
    
    if (supplier !== undefined) {
      updates.push(`supplier = $${paramIndex++}`);
      queryParams.push(supplier);
    }
    
    if (warranty_expiry !== undefined) {
      updates.push(`warranty_expiry = $${paramIndex++}`);
      queryParams.push(warranty_expiry);
    }
    
    if (status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      queryParams.push(status);
    }
    
    if (assigned_to !== undefined) {
      updates.push(`assigned_to = $${paramIndex++}`);
      queryParams.push(assigned_to);
    }
    
    if (department_id !== undefined) {
      updates.push(`department_id = $${paramIndex++}`);
      queryParams.push(department_id);
    }
    
    if (room_id !== undefined) {
      updates.push(`room_id = $${paramIndex++}`);
      queryParams.push(room_id);
    }
    
    if (notes !== undefined) {
      updates.push(`notes = $${paramIndex++}`);
      queryParams.push(notes);
    }
    
    if (last_maintenance_date !== undefined) {
      updates.push(`last_maintenance_date = $${paramIndex++}`);
      queryParams.push(last_maintenance_date);
    }
    
    if (next_maintenance_date !== undefined) {
      updates.push(`next_maintenance_date = $${paramIndex++}`);
      queryParams.push(next_maintenance_date);
    }
    
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updateQuery += updates.join(', ') + ` WHERE id = $${paramIndex} RETURNING *`;
    queryParams.push(id);
    
    const result = await client.query(updateQuery, queryParams);
    
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating asset:', error);
    res.status(500).json({ error: 'Failed to update asset' });
  } finally {
    client.release();
  }
});

// Delete an asset
router.delete('/assets/:id',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    
    // Check if asset exists
    const checkResult = await client.query('SELECT id FROM assets WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    // Delete related maintenance records
    await client.query('DELETE FROM asset_maintenance WHERE asset_id = $1', [id]);
    
    // Delete related transfer records
    await client.query('DELETE FROM asset_transfers WHERE asset_id = $1', [id]);
    
    // Delete the asset
    await client.query('DELETE FROM assets WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    res.json({ message: 'Asset deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting asset:', error);
    res.status(500).json({ error: 'Failed to delete asset' });
  } finally {
    client.release();
  }
});

/**
 * ASSET MAINTENANCE ROUTES
 */

// Record maintenance for an asset
router.post('/assets/:id/maintenance',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      maintenance_date,
      maintenance_type,
      performed_by,
      cost,
      description,
      next_maintenance_date,
      status
    } = req.body;
    
    // Check if asset exists
    const checkResult = await client.query('SELECT id FROM assets WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }
    
    // Insert maintenance record
    const result = await client.query(
      `INSERT INTO asset_maintenance (
        asset_id, maintenance_date, maintenance_type, performed_by,
        cost, description, next_maintenance_date, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        id, maintenance_date, maintenance_type, performed_by,
        cost, description, next_maintenance_date, status || 'completed'
      ]
    );
    
    // Update asset's maintenance dates
    await client.query(
      `UPDATE assets SET 
        last_maintenance_date = $1,
        next_maintenance_date = $2,
        status = CASE WHEN $3 = 'completed' THEN 'active' ELSE 'maintenance' END
      WHERE id = $4`,
      [maintenance_date, next_maintenance_date, status || 'completed', id]
    );
    
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error recording maintenance:', error);
    res.status(500).json({ error: 'Failed to record maintenance' });
  } finally {
    client.release();
  }
});

/**
 * INVENTORY ROUTES
 */

// Get all inventory items with optional filtering
router.get('/inventory', async (req, res) => {
  try {
    const { search, category } = req.query;
    
    let query = `
      SELECT i.*, ic.name as category
      FROM inventory_items i
      LEFT JOIN inventory_categories ic ON i.category_id = ic.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    if (search) {
      queryParams.push(`%${search}%`);
      query += ` AND (i.name ILIKE $${queryParams.length} 
                OR i.item_code ILIKE $${queryParams.length} 
                OR i.description ILIKE $${queryParams.length})`;
    }
    
    if (category && category !== 'all') {
      queryParams.push(`%${category}%`);
      query += ` AND ic.name ILIKE $${queryParams.length}`;
    }
    
    query += ' ORDER BY i.name ASC';
    
    const { rows } = await pool.query(query, queryParams);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching inventory items:', error);
    res.status(500).json({ error: 'Failed to retrieve inventory items' });
  }
});

// Get a single inventory item by ID
router.get('/inventory/:id', authorizeRoles('admin', 'teacher', 'staff'),async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT i.*, ic.name as category
       FROM inventory_items i
       LEFT JOIN inventory_categories ic ON i.category_id = ic.id
       WHERE i.id = $1`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching inventory item:', error);
    res.status(500).json({ error: 'Failed to retrieve inventory item' });
  }
});

// Create a new inventory item
router.post('/inventory',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      item_code,
      name,
      category_id,
      description,
      unit,
      current_quantity,
      min_quantity,
      unit_cost,
      supplier,
      storage_location
    } = req.body;
    
    // Check if item_code already exists
    const checkResult = await client.query(
      'SELECT id FROM inventory_items WHERE item_code = $1',
      [item_code]
    );
    
    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Item code already exists' });
    }
    
    const result = await client.query(
      `INSERT INTO inventory_items (
        item_code, name, category_id, description, unit,
        current_quantity, min_quantity, unit_cost, supplier, storage_location
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        item_code, name, category_id, description, unit,
        current_quantity || 0, min_quantity || 5, unit_cost, supplier, storage_location
      ]
    );
    
    // If initial quantity > 0, create a transaction record
    if (current_quantity > 0) {
      await client.query(
        `INSERT INTO inventory_transactions (
          item_id, transaction_type, quantity, transaction_date,
          notes, unit_cost
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          result.rows[0].id, 'in', current_quantity, new Date(),
          'Initial inventory', unit_cost
        ]
      );
      
      // Update last_restocked date
      await client.query(
        'UPDATE inventory_items SET last_restocked = $1 WHERE id = $2',
        [new Date(), result.rows[0].id]
      );
    }
    
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating inventory item:', error);
    res.status(500).json({ error: 'Failed to create inventory item' });
  } finally {
    client.release();
  }
});

// Update an inventory item
router.patch('/inventory/:id', authorizeRoles('admin', 'teacher', 'staff'),async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      name,
      category_id,
      description,
      unit,
      current_quantity,
      min_quantity,
      unit_cost,
      supplier,
      storage_location
    } = req.body;
    
    // Check if inventory item exists
    const checkResult = await client.query('SELECT id, current_quantity FROM inventory_items WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    
    const oldQuantity = parseInt(checkResult.rows[0].current_quantity);
    
    // Build dynamic update query
    let updateQuery = 'UPDATE inventory_items SET ';
    let queryParams = [];
    let paramIndex = 1;
    let updates = [];
    
    // Add fields if they exist in the request body
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      queryParams.push(name);
    }
    
    if (category_id !== undefined) {
      updates.push(`category_id = $${paramIndex++}`);
      queryParams.push(category_id);
    }
    
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      queryParams.push(description);
    }
    
    if (unit !== undefined) {
      updates.push(`unit = $${paramIndex++}`);
      queryParams.push(unit);
    }
    
    if (current_quantity !== undefined) {
      updates.push(`current_quantity = $${paramIndex++}`);
      queryParams.push(current_quantity);
    }
    
    if (min_quantity !== undefined) {
      updates.push(`min_quantity = $${paramIndex++}`);
      queryParams.push(min_quantity);
    }
    
    if (unit_cost !== undefined) {
      updates.push(`unit_cost = $${paramIndex++}`);
      queryParams.push(unit_cost);
    }
    
    if (supplier !== undefined) {
      updates.push(`supplier = $${paramIndex++}`);
      queryParams.push(supplier);
    }
    
    if (storage_location !== undefined) {
      updates.push(`storage_location = $${paramIndex++}`);
      queryParams.push(storage_location);
    }
    
    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No fields to update' });
    }
    
    updateQuery += updates.join(', ') + ` WHERE id = $${paramIndex} RETURNING *`;
    queryParams.push(id);
    
    const result = await client.query(updateQuery, queryParams);
    
    // If quantity changed, create a transaction record
    if (current_quantity !== undefined && current_quantity !== oldQuantity) {
      const difference = current_quantity - oldQuantity;
      const transactionType = difference > 0 ? 'in' : 'out';
      const quantity = Math.abs(difference);
      
      await client.query(
        `INSERT INTO inventory_transactions (
          item_id, transaction_type, quantity, transaction_date,
          notes, unit_cost
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id, transactionType, quantity, new Date(),
          'Manual adjustment', unit_cost || result.rows[0].unit_cost
        ]
      );
      
      // Update last_restocked date if it's a stock-in transaction
      if (transactionType === 'in') {
        await client.query(
          'UPDATE inventory_items SET last_restocked = $1 WHERE id = $2',
          [new Date(), id]
        );
      }
    }
    
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating inventory item:', error);
    res.status(500).json({ error: 'Failed to update inventory item' });
  } finally {
    client.release();
  }
});

// Delete an inventory item
router.delete('/inventory/:id',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    
    // Check if inventory item exists
    const checkResult = await client.query('SELECT id FROM inventory_items WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    
    // Delete related transaction records
    await client.query('DELETE FROM inventory_transactions WHERE item_id = $1', [id]);
    
    // Delete the inventory item
    await client.query('DELETE FROM inventory_items WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    res.json({ message: 'Inventory item deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting inventory item:', error);
    res.status(500).json({ error: 'Failed to delete inventory item' });
  } finally {
    client.release();
  }
});

/**
 * INVENTORY TRANSACTION ROUTES
 */

// Record inventory transaction (stock in/out)
router.post('/inventory/:id/transactions', authorizeRoles('admin', 'teacher', 'staff'),async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const {
      transaction_type,
      quantity,
      performed_by,
      notes,
      recipient,
      department_id,
      reference_number,
      unit_cost
    } = req.body;
    
    // Check if inventory item exists
    const itemResult = await client.query(
      'SELECT id, current_quantity, unit_cost FROM inventory_items WHERE id = $1',
      [id]
    );
    
    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    
    const currentQuantity = parseInt(itemResult.rows[0].current_quantity);
    const currentUnitCost = parseFloat(itemResult.rows[0].unit_cost) || 0;
    
    // Validate transaction
    if (transaction_type === 'out' && quantity > currentQuantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient inventory quantity' });
    }
    
    // Insert transaction record
    const transactionResult = await client.query(
      `INSERT INTO inventory_transactions (
        item_id, transaction_type, quantity, transaction_date,
        performed_by, notes, recipient, department_id, reference_number, unit_cost
      ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        id, transaction_type, quantity, performed_by,
        notes, recipient, department_id, reference_number, unit_cost || currentUnitCost
      ]
    );
    
    // Update inventory item quantity
    let newQuantity;
    if (transaction_type === 'in') {
      newQuantity = currentQuantity + parseInt(quantity);
      
      // Update last_restocked date
      await client.query(
        'UPDATE inventory_items SET last_restocked = CURRENT_TIMESTAMP WHERE id = $1',
        [id]
      );
    } else {
      newQuantity = Math.max(0, currentQuantity - parseInt(quantity));
    }
    
    await client.query(
      'UPDATE inventory_items SET current_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newQuantity, id]
    );
    
    await client.query('COMMIT');
    res.status(201).json(transactionResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error recording inventory transaction:', error);
    res.status(500).json({ error: 'Failed to record inventory transaction' });
  } finally {
    client.release();
  }
});

/**
 * CATEGORY ROUTES
 */

// Get asset categories
router.get('/asset-categories',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM asset_categories ORDER BY name ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching asset categories:', error);
    res.status(500).json({ error: 'Failed to retrieve asset categories' });
  }
});

// Get inventory categories
router.get('/inventory-categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM inventory_categories ORDER BY name ASC');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching inventory categories:', error);
    res.status(500).json({ error: 'Failed to retrieve inventory categories' });
  }
});

// Create asset category
router.post('/asset-categories', async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    
    const result = await pool.query(
      'INSERT INTO asset_categories (name, description) VALUES ($1, $2) RETURNING *',
      [name, description]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating asset category:', error);
    res.status(500).json({ error: 'Failed to create asset category' });
  }
});

// Create inventory category
router.post('/inventory-categories',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    
    const result = await pool.query(
      'INSERT INTO inventory_categories (name, description) VALUES ($1, $2) RETURNING *',
      [name, description]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating inventory category:', error);
    res.status(500).json({ error: 'Failed to create inventory category' });
  }
});

export default router