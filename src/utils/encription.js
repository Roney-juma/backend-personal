// #option1
require('dotenv').config();
const crypto = require('crypto');
const EncryptionSecret = process.env.ENCRYPTION_SECRET;

if (!EncryptionSecret) {
  throw new Error('ENCRYPTION_SECRET is not set — required for Encrypt/Decrypt.');
}

const Encrypt = (plain) => {
  const iv = crypto.randomBytes(10);
  const salt = crypto.randomBytes(10);
  const key = crypto.pbkdf2Sync(EncryptionSecret, salt, 2145, 32, 'sha512');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  const tag = cipher.getAuthTag();

  return salt.toString('hex') + '-' + iv.toString('hex') + '-' + tag.toString('hex') + '-' + encrypted.toString('hex');
};




const Decrypt = (data) => {
  const parts = data.split('-');

  if (parts.length !== 4) {
    return null;
  }

  const salt = Buffer.from(parts[0], 'hex');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const text = parts[3];

  const key = crypto.pbkdf2Sync(EncryptionSecret, salt, 2145, 32, 'sha512');

  let decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag, 'hex');

  const decrypted = decipher.update(text, 'hex', 'utf8') + decipher.final('utf8');

  return decrypted;
};

const encryptToken = 'this one';

const encryptThis = 'text';

var asciiArr = new Array();
var atozArr = new Array();
var encryptedString = new Array();

function randomIndexFromInterval(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

const encryptCodes = (content) => {
  let result;
  for (i = 0; i < content.length; i++) {
    asciiArr[i] = content[i].charCodeAt(0);
  }

  for (i = 0, code = 65; i < 26; i++, code++) {
    atozArr[i] = String.fromCharCode(code);
  }

  let position = randomIndexFromInterval(0, atozArr.length - 1);
  let positionAscii = atozArr[position].charCodeAt(0);

  for (i = 0; i < content.length; i++) {
    encryptedString[i] = parseInt(asciiArr[i]) + parseInt(atozArr[position].charCodeAt(0));
  }

  encryptedString[asciiArr.length] = positionAscii;

  for (i = 0; i < encryptedString.length; i++) {
    result = String.fromCharCode(encryptedString[i]);
  }
  return result;
};

const decryptCodes = (content) => {
  var result = [];
  var str = '';
  var codesArr = JSON.parse(content);
  var passLen = encryptToken.length;
  for (var i = 0; i < codesArr.length; i++) {
    var passOffset = i % passLen;
    var calAscii = codesArr[i] - encryptToken.charCodeAt(passOffset);
    result.push(calAscii);
  }
  for (var i = 0; i < result.length; i++) {
    var ch = String.fromCharCode(result[i]);
    str += ch;
  }
  return str;
};

// TODO: decide the best approach between this and #option1
// const encryptCodes = (content) => {
//   var result = [];
//   var passLen = encryptToken.length;
//   for (var i = 0; i < content.length; i++) {
//     var passOffset = i % passLen;
//     var calAscii = content.charCodeAt(i) + encryptToken.charCodeAt(passOffset);
//     result.push(calAscii);
//   }
//   return JSON.stringify(result);
// };

// const decryptCodes = (content) => {
//   var result = [];
//   var str = '';
//   var codesArr = JSON.parse(content);
//   var passLen = encryptToken.length;
//   for (var i = 0; i < codesArr.length; i++) {
//     var passOffset = i % passLen;
//     var calAscii = codesArr[i] - encryptToken.charCodeAt(passOffset);
//     result.push(calAscii);
//   }
//   for (var i = 0; i < result.length; i++) {
//     var ch = String.fromCharCode(result[i]);
//     str += ch;
//   }
//   return str;
// };

// var webdevencrypt = {
//   setEncrypt: function(source,destination,passcode) {
//       document.getElementById(destination).innerText = this.encryptCodes(document.getElementById(source).value,document.getElementById(passcode).value);
//   },
//   setDecrypt: function() {
//               document.getElementById('decryptedContent').innerText = this.decryptCodes(document.getElementById('originalContent').value,document.getElementById('passcode').value);
//   },
//   encryptCodes: function(content,passcode) {
//       var result = []; var passLen = passcode.length ;
//       for(var i = 0  ; i < content.length ; i++) {
//           var passOffset = i%passLen ;
//           var calAscii = (content.charCodeAt(i)+passcode.charCodeAt(passOffset));
//           result.push(calAscii);
//       }
//       return JSON.stringify(result) ;
//   },
//   decryptCodes: function(content,passcode) {
//       var result = [];var str = '';
//       var codesArr = JSON.parse(content);var passLen = passcode.length ;
//       for(var i = 0  ; i < codesArr.length ; i++) {
//           var passOffset = i%passLen ;
//           var calAscii = (codesArr[i]-passcode.charCodeAt(passOffset));
//           result.push(calAscii) ;
//       }
//       for(var i = 0 ; i < result.length ; i++) {
//           var ch = String.fromCharCode(result[i]); str += ch ;
//       }
//       return str ;
//   }
// }

module.exports = { Encrypt, Decrypt, encryptCodes, decryptCodes };
