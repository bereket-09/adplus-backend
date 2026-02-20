const express = require("express");
const router = express.Router();
const MarketerController = require("../../controllers/marketer.controller");

// login marketer
router.post("/login", MarketerController.login);
router.post("/register", MarketerController.register);

module.exports = router;
