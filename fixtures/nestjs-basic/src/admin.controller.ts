import { Controller, Get, Delete } from '@nestjs/common';

// object-form @Controller - the E1-validated edge case
@Controller({ path: 'admin' })
export class AdminController {
  @Get('stats')
  stats() { return { ok: true }; }

  @Delete('cache')
  clearCache() { return true; }
}
