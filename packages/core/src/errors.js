/** 带机器可读 code 的领域错误（not_found/conflict/active/invalid）。 */
export class CsmError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CsmError'
    this.code = code
  }
}
