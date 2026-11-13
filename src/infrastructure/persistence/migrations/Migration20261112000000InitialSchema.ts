import { Migration } from "@mikro-orm/migrations";
import { DOWN_0001, UP_0001 } from "./sql/0001-initial-schema.sql";

export class Migration20261112000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(UP_0001);
  }

  override async down(): Promise<void> {
    this.addSql(DOWN_0001);
  }
}
