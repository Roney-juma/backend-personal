const mongoose = require('mongoose');

const supplyBidSchema = new mongoose.Schema({
    claimId: { type: mongoose.Schema.Types.ObjectId, ref: 'Claim', required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    parts: [{
      partName: String,
      cost: Number
    }],
    totalCost: { type: Number, required: true },
    bidDate: { type: Date, default: Date.now },
    status: { 
      type: String, 
      enum: ['Pending', 'Accepted','Delivered', 'Rejected'], 
      default: 'Pending' 
    }
  }, { timestamps: true });
  
  module.exports = mongoose.model('SupplyBid', supplyBidSchema);
  