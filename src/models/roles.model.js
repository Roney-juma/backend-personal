const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const roleSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true, 
        unique: true 
    },
    permissions: [{ type: String }]
}, { timestamps: true });

roleSchema.plugin(softDelete);

const Role = mongoose.model('Role', roleSchema);
module.exports = Role;
