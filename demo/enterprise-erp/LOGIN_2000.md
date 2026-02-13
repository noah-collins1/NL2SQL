# 2000-Table ERP Database Login

This repo includes a 2000-table ERP-style PostgreSQL database generated via schema replication + module deepening.

## Default Connection
- Database: `enterprise_erp_2000`
- User: `erp_readonly`
- Password: `treyco`
- Host: `localhost`
- Port: `5432`

## Setup

```bash
chmod +x schema_gen/apply_schema.sh
./schema_gen/apply_schema.sh
```

## Connect

```bash
psql postgresql://erp_readonly:treyco@localhost:5432/enterprise_erp_2000
```

## Verify Table Count

```bash
psql -d enterprise_erp_2000 -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema LIKE 'div_%' AND table_type = 'BASE TABLE';"
# Expected: 2120 (106 per division x 20 divisions)
```

## Validate

```bash
python3 validation/validate.py --db enterprise_erp_2000
```
