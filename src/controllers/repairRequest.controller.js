

// Create a Repair Request

const createRequest = async (req, res) => {
  try {
    const newRepairRequest = new RepairRequest(req.body);
    const savedRepairRequest = await newRepairRequest.save();
    res.status(201).json(savedRepairRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Get All Repair Requests
const getAllRequests = async (req, res) => {
try {
    const repairRequests = await RepairRequest.find().populate('garageId').populate('claimId');
    res.status(200).json(repairRequests);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get a Specific Repair Request
const getRequest = async (req, res) => {
  try {
    const repairRequest = await RepairRequest.findById(req.params.repairId).populate('garageId').populate('claimId');
    if (!repairRequest) return res.status(404).json({ message: 'Repair request not found' });
    res.status(200).json(repairRequest);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
// Update a Repair Request
const updateRequest = async (req, res) => {
  try {
    const updatedRepairRequest = await RepairRequest.findByIdAndUpdate(req.params.repairId, req.body, { new: true });
    if (!updatedRepairRequest) return res.status(404).json({ message: 'Repair request not found' });
    res.status(200).json(updatedRepairRequest);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete a Repair Request
const deleteRequest = async (req, res) => {
  try {
    const deletedRepairRequest = await RepairRequest.softDeleteById(req.params.repairId);
    if (!deletedRepairRequest) return res.status(404).json({ message: 'Repair request not found' });
    res.status(200).json({ message: 'Repair request deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
module.exports = {
    createRequest,
    getAllRequests,
    getRequest,
    updateRequest,
    deleteRequest
    };