const mongoose = require('mongoose');
const softDelete = require('./plugins/softDelete');

const roleSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    // Tenant that owns this role. null = global/platform role (e.g. "Super Admin"),
    // visible to every tenant but mutable only by AVE staff.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'InsuranceCompany', index: true, default: null },
    permissions: [{ type: String }]
}, { timestamps: true });

// Role names are unique within a tenant (and among global roles), not globally —
// two insurers can each have their own "Claims Manager".
// NOTE: the migration script must drop the old unique index on { name: 1 }.
roleSchema.index({ company: 1, name: 1 }, { unique: true });

roleSchema.plugin(softDelete);

const Role = mongoose.model('Role', roleSchema);
module.exports = Role;
