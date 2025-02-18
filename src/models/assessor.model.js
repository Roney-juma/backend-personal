const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { ObjectId } = require("mongodb")
const Token = require('./token.model')


const assessorSchema = new Schema({
  name: { type: String, required: true },
  password: { type: String, required: true },
  email: { type: String, required: true },
  contactInfo: {
    phone: { type: String, required: true },
    email: { type: String, required: true }
  },
  location: {
    name: String,
    estate: String,
    city: String,
    state: String,
    zip: String,
    longitude: Number,
    latitude: Number
  },
  licenseNumber: { type: String },
  accountType: {
    type: String,
    default: 'Assessor',
  },
  experience: { type: Number, },
  specialties: [String],
  ratings: {
    averageRating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    reviews: [{
      customerId: { type: ObjectId, ref: 'Customer' },
      rating: { type: Number },
      feedback: { type: String },
      createdAt: { type: Date, default: Date.now }
    }]
  }
}, { timestamps: true });

assessorSchema.pre('save', async function (next) {
  // Hash the password before saving the user model
  const user = this
  if (user.isModified('password')) {
    user.password = await bcrypt.hash(user.password, 8)
  }
  next()
})

assessorSchema.pre('findOneAndUpdate', async function (next) {
  // Hash the password before saving the user model

  const user = this
  if (user._update.password != undefined) {
    if (user._update.password.substr(0, 7) != '$2a$08$') {
      user._update.password = await bcrypt.hash(user._update.password, 8)
    }
  }
  next()
})

// generate token for reset password
assessorSchema.methods.generateResetToken = async function () {
  const user = this

  /* Reset token generation */
  const resetTokenExpires = moment().add(process.env.JWT_REFRESH_EXPIRATION_HOURS, 'hours');

  const Refershpayload = {
    _id: user._id,
    iat: moment().unix(),
    exp: resetTokenExpires.unix(),
    type: 'reset_password',
  };


  const resetToken = jwt.sign(Refershpayload, process.env.JWT_KEY)

  let token = {
    blacklisted: false,
    token: resetToken,
    user: user._id,
    expires: resetTokenExpires,
    type: 'reset_password',
  }

  const token_insert = new Token(token);
  let insertToken = await token_insert.save();

  return resetToken;
}


assessorSchema.methods.generateAuthToken = async function () {
  // Generate an auth token for the user
  const user = this
  const token = jwt.sign({ _id: user._id }, process.env.JWT_KEY)
  user.tokens = user.tokens.concat({ token })
  //await user.save()
  return token
}

assessorSchema.methods.generateAuthTokens = async function () {
  const user = this
  /* Access token generation */
  const accessTokenExpires = moment().add(process.env.JWT_ACCESS_EXPIRATION_MINUTES, 'minutes');

  const Accesspayload = {
    _id: user._id,
    iat: moment().unix(),
    exp: accessTokenExpires.unix(),
    type: 'access',
  };
  const accessToken = jwt.sign(Accesspayload, process.env.JWT_KEY)

  /* Refresh token generation */
  const refreshTokenExpires = moment().add(process.env.JWT_REFRESH_EXPIRATION_HOURS, 'hours');

  const Refershpayload = {
    _id: user._id,
    iat: moment().unix(),
    exp: refreshTokenExpires.unix(),
    type: 'refresh',
  };


  const refreshToken = jwt.sign(Refershpayload, process.env.JWT_KEY)

  let token = {
    blacklisted: false,
    token: refreshToken,
    user: user._id,
    expires: refreshTokenExpires,
    type: 'refresh',
  }

  const token_insert = new Token(token);
  let insertToken = await token_insert.save();
  // await saveToken(refreshToken, user.id, refreshTokenExpires, tokenTypes.REFRESH, false, isFreelancer);

  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires.toDate(),
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires.toDate(),
    },
  };
}

assessorSchema.methods.startSession = async function () {

  const user = this;
  let obj = {
    user_id: user._id,
    session_id: uuidv4(),
    routes: [],
    session_status: 'started'
  }
  const session = new sessionModel(obj)
  const insert = await session.save()

  return obj;
}

assessorSchema.methods.checkRole = async function () {

  let user = this
  user.isAdmin = false
  user.isEmployee = false
  user.isHR = false
  user.isManager = false
  user.isFinanceMgr = false
  user.isHRMgr = false
  user.isSalAcc = false
  user.isOnboarding = false


  if (user.role_ID == '5e2ec39af3185a0b5036ef01') {
    user.isAdmin = true
  } else if (user.role_ID == '5e2ec3a7f3185a0b5036ef03') {
    user.isHR = true
  } else if (user.role_ID == '5e2ec39af3185a0b5036ef03') {
    user.isManager = true
  } else if (user.role_ID == '5e438bda1c9d4400000db544') {
    user.isEmployee = true
  } else if (user.role_ID == '5faa42e86342f902b46ab443') {
    user.isFinanceMgr = true
  } else if (user.role_ID == '5e2ec3a7f3185a0b5036ef02') {
    user.isHRMgr = true
  } else if (user.role_ID == '5e2ec3a7f3185a0b5036ef04') {
    user.isSalAcc = true
  }

  if (user.user_status == 'Onboarding') {
    user.isOnboarding = true
  }

  return user

}

assessorSchema.methods.checkIsAdmin = async function () {
  // Generate an auth token for the user
  const user = this
  let isAdmin = false

  if (user.role_ID == '5e2ec39af3185a0b5036ef01') {
    isAdmin = true
  }
  //await user.save()
  return isAdmin
}


assessorSchema.methods.checkIsHR = async function () {
  // Generate an auth token for the user
  const user = this
  let isHR = false

  if (user.role_ID == '5e2ec3a7f3185a0b5036ef03') {
    isHR = true
  }
  //await user.save()
  return isHR
}

assessorSchema.methods.checkIsManager = async function () {
  // Generate an auth token for the user	
  const user = this
  let isManager = false
  if (user.role_ID == '5e2ec39af3185a0b5036ef03') {
    isManager = true
  }
  //await user.save()	
  return isManager
}

assessorSchema.methods.checkIsOnboarding = async function () {
  // Generate an auth token for the user
  const user = this
  let isOnboarding = false

  if (user.user_status == 'Onboarding') {
    isOnboarding = true
  }
  //await user.save()
  return isOnboarding
}

assessorSchema.methods.checkIsEmployee = async function () {
  // Generate an auth token for the user
  const user = this
  let isEmployee = false

  if (user.role_ID == '5e438bda1c9d4400000db544') {
    isEmployee = true
  }
  //await user.save()
  return isEmployee
}

assessorSchema.methods.checkIsFinanceMgr = async function () {
  // Generate an auth token for the user
  const user = this
  let isFinanceMgr = false
  if (user.role_ID == '5faa42e86342f902b46ab443') {
    isFinanceMgr = true
  }
  //await user.save()
  return isFinanceMgr
}


assessorSchema.methods.checkUserFirstLogin = async function () {
  const user = this
  let userFirstLogin = false
  let firstLogin = 'firstLogin'
  if (firstLogin in user) {
    if (user.firstLogin == true) {
      userFirstLogin = true
    }
    else {
      userFirstLogin = false
    }
  }
  else {
    userFirstLogin = false
  }
  return userFirstLogin
}

assessorSchema.statics.findByCredentials = async (email, password) => {
  // Search for a user by email and password.
  const user = await Users.findOne({ email: email })

  if (!user) {
    throw new Error({ error: 'Invalid login credentials' })
  }
  const isPasswordMatch = await bcrypt.compare(password, user.password)
  if (!isPasswordMatch) {
    throw new Error({ error: 'Invalid login credentials' })
  }
  return user
}

// find by email
assessorSchema.statics.findByEmail = async (email) => {
  // Search for a user by email.
  const user = await Users.findOne({ email: email, user_status: { $ne: 'Inactive' } });
  if (!user) {
    throw new Error({ error: 'No User Found' })
  }
  return user
}


// find by email
assessorSchema.statics.findByEmailAddress = async (email) => {
  // Search for a user by email.
  const user = await Users.findOne({ email: email, user_status: { $ne: 'Inactive' } });
  if (!user) {
    throw new Error({ error: 'No User Found' })
  }
  return user
}

/**
* Check if password matches the user's password
* @param {string} password
* @returns {Promise<boolean>}
*/
assessorSchema.methods.isPasswordMatch = async function (password) {
  const user = this;
  const data = await bcrypt.compare(password, user.password);

  return data
};


const Assessor = mongoose.model('Assessor', assessorSchema);
module.exports = Assessor;
