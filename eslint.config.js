import { runner } from './eslint.base.js'

export default [...runner(), { ignores: ['packages/**'] }]
