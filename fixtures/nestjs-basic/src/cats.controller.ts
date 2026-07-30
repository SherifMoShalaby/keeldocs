import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';

@Controller('cats')
export class CatsController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne(@Param('id') id: string) { return { id }; }

  @Post()
  create(@Body() dto: object) { return dto; }
}
