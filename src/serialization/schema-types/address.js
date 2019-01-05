const web3 = require('web3')
const BaseSchemaType = require('./base-schema-type')

class SchemaAddress extends BaseSchemaType {
  constructor (options) {
    super(options)

    this.validators = {
      required: (_) => {
        return {
          validate: (v) => {
            return (web3.utils.isAddress(v))
          },
          message: 'Address must be a valid Ethereum address',
          type: 'required'
        }
      }
    }

    this._initValidators()
  }

  get length () {
    return 40
  }

  encode (value) {
    return value.substring(2)
  }

  decode (value) {
    return '0x' + value
  }
}

module.exports = SchemaAddress