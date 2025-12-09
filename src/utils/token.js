const { randomUUID } = require('crypto');

exports.generateToken = () => {
  return randomUUID().replace(/-/g,'');
};
