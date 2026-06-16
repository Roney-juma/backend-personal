const admin = require('firebase-admin');
const { getApps, initializeApp, cert } = require('firebase-admin/app');

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: 'canvas-griffin-233009',
      clientEmail: 'firebase-adminsdk-mcqqt@canvas-griffin-233009.iam.gserviceaccount.com',
      privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDT+Ry4B09wudKV\n7ndAkqLsDyKJkW+6FwBDK7cF8FSJjy3l3DUgevozyDiI0hIyWH+Svv1tj0YGX610\nOJX5vDZJ/+BdPkbNcN8f0nGjZcleCECzqYsHfkxyLigdh0DXQECewBVsMzoZPpuY\nor6M8+8yl1EEPib+aBat9oHDy0GLVxWtJXb2Al4XbKO6tsvwS2eNc1v/l6D8JhDb\ncMzWyypR5lIbjVz7QMqSmvaKlsG0sjvCicPEWYBzT14oBqFy80JJMsHLNPLY+dlF\ny89k/M2sPMjZYZlPayeVMgNcRuAAigyQHrg0UySXiQV4rIfg2FSLcdM67Nh56R4b\nQZ+GVyatAgMBAAECggEACg0IVxOFqUcuXIybm/S4A/Btx08dmJnJmeXDPmVYZNNk\nrj8ER9986KKoR5iKY1e96NPkiWLfQ6MawuWB+v75JgYbeeBflBMziTs9xy0m4K4M\nf1hdLsRG1K0qmsfUg8BYsA5UlbZSHWtSDmk9FsrkPyZcoZJe3/ZIiQQkwAdturEW\ny9WV5GmqUGbGlidb+aylNYqMesyb/1r21riUHwvjnF6Bk56tUl+G8tmcA0HdCbLr\ndj2GmPd3gPbUAHJGX7dPRatWLudfBPVV3XGl4VLOrTULhZJRGo1vimCRxXIQ5JwS\n2VH53YjxobijuRDEVA7PPGSUDQKKTs+KCu0U7ZvWQQKBgQDxElGODZpakXOvbpui\nFt72ofyYyrtZlY8bMjV+nengCgcGAZ21JSC/XIkzJDhsWhsg/iXvP5fsxoHEvSmp\n/65nWN0Jm5/JaLVIeDejF0P1QNTF4VpzXXDl+YVWoOnhW1vm/TycGW812dO8Tcbl\n8khMnzDXzd4YZMTs499yObJSoQKBgQDhGX+yiUrVA3kZdQNNrrLtjCChkPSZID06\n+D3+9gbX1PDOyfbT3Xg03XamiURmcV9HKFHNT5Lee6Kj5gAd9tunvZQ3xlYF3SWQ\nSSZVAJkBR41aSJGocrH1gM8jm18b1b8uuhHqt248s42KmkcEGor7Qrp1Qr9O/DvO\nfDPujOEkjQKBgQDN6sPW/y+VpSCX/XbbIYYaTYuiR6l4gBPZOy4OlXysbmRJcR/x\nF2G9k6FuGcZIZz89E1n73uo6yeUW1C2+lDO4+2LzTgdS1yniWS3NFZZq65HT5QaJ\n/IrvJhALSy/72znJOQ6ImAEyknoWIql+yVGQgXoLHEJVu92qK4s12qrDgQKBgF8r\nJK4bFaRRv5Vfv3HMdqGwKOumGYPT+Y9A/RUad3Iw+U60XMLeU8AmEc//IQgezqWL\nCmq/Rd0CcJTS3SHOCLg2kr+x/xSjlwoVozs08Xt1API21D5fn5WoS+tF+UQPbrEW\nwhR2UQkg8Kq052l4v2HTqHmDKtb+FVsLb/lfXqDRAoGBAJrzOX3YlcSIVyrafHdb\nrF9JaSeB+ZKHrRiJKNG8nC+iO6s8aflYfw6hlFZPiiPrQG9OoTKB0JWy+11e+FOc\nLvg29hb0Buuph7wv+7RHHT4P+pjZ04AWcsIEZJf0mIIfQMH6OMcIzvzr+ibQDHwF\nBKvzQwrFSV4ObWVm/dHRvD9r\n-----END PRIVATE KEY-----\n",
    }),
  });
}

module.exports = admin;
