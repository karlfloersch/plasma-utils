const Web3 = require('web3')

/**
 * Base model that makes use of a particular schema.
 * Can be extended by other classes with different schemas.
 */
class BaseModel {
  constructor (args, schema) {
    this.schema = schema

    if (args instanceof String || typeof args === 'string') {
      args = this.schema.decode(args)
    }
    if (Buffer.isBuffer(args)) {
      args = this.schema.decode(args.toString('hex'))
    }

    this.args = this.schema.cast(args)
    this.schema.validate(args)

    // Remove any reserved properties.
    const illegal = ['schema']
    for (let prop of Object.getOwnPropertyNames(BaseModel.prototype).concat(
      illegal
    )) {
      if (prop in args) {
        delete args[prop]
      }
    }
    Object.assign(this, this.args)
  }

  get encoded () {
    return this.schema.encode(this.args)
  }

  get decoded () {
    return this.args
  }

  get hash () {
    return Web3.utils.sha3('0x' + this.encoded)
  }
}

module.exports = BaseModel
