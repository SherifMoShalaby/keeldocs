const express = require('express');
const router = express.Router();

router.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

module.exports = router;
