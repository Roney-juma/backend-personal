const softDelete = require('./plugins/softDelete');

const repairRequestSchema = new mongoose.Schema({
    claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim', required: true },
    garageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Garage', required: true },
    repairStatus: { type: String, enum: ['Pending', 'In Progress', 'Completed'], default: 'Pending' },
    estimatedCost: { type: Number },
    actualCost: { type: Number },
    requestedAt: { type: Date, default: Date.now },
    completedAt: Date,
  }, { timestamps: true });
  
  repairRequestSchema.plugin(softDelete);

  module.exports = mongoose.model('RepairRequest', repairRequestSchema);
  