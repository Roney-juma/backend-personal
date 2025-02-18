const express = require('express');

const router = express.Router();
const userController = require("../controllers/users.controller");
const verifyToken = require("../middlewheres/verifyToken");

// router.use(verifyToken)

router.get('/',verifyToken(),userController.getAllUsers)
router.post('/create', userController.createUser)
router.post('/login', userController.login)
router.patch('/update/:id',verifyToken(),userController.updateAdminUser)
router.get('/:id',verifyToken(), userController.getAdminUser)
router.patch('/delete/:id',verifyToken(), userController.deleteAdminUser)
router.post('/reset-password',verifyToken(), userController.resetPassword);




module.exports = router;
