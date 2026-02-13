-- Expand Enterprise ERP schema to 2000 tables
-- Adds 1,915 ERP-style tables with minimal seed data for NL2SQL testing

DO $$
DECLARE
    m INT;
    cnt BIGINT;
    prefix TEXT;
    tbl TEXT;
BEGIN
    -- Create 100 module shards, 19 tables each = 1,900 tables
    FOR m IN 1..100 LOOP
        prefix := format('xmod_%03s', m);

        -- contracts
        tbl := prefix || '_contracts';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            contract_id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(customer_id),
            owner_employee_id INT REFERENCES employees(employee_id),
            start_date DATE,
            end_date DATE,
            status VARCHAR(20),
            total_value DECIMAL(12,2)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (customer_id, owner_employee_id, start_date, end_date, status, total_value)
                SELECT ((s-1) %% 1000)+1, ((s-1) %% 500)+1,
                       CURRENT_DATE - (s*30), CURRENT_DATE + (s*30),
                       ''active'', 10000 + s*100
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- contract_lines
        tbl := prefix || '_contract_lines';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            contract_line_id SERIAL PRIMARY KEY,
            contract_id INT REFERENCES %I(contract_id),
            product_id INT REFERENCES products(product_id),
            qty INT,
            unit_price DECIMAL(10,2),
            line_total DECIMAL(12,2)
        )', tbl, prefix || '_contracts');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (contract_id, product_id, qty, unit_price, line_total)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 2000)+1, 1 + (s %% 5), 100 + s, (1 + (s %% 5)) * (100 + s)
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- service_orders
        tbl := prefix || '_service_orders';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            service_order_id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(customer_id),
            requested_by INT REFERENCES employees(employee_id),
            order_date DATE,
            status VARCHAR(20),
            priority VARCHAR(20)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (customer_id, requested_by, order_date, status, priority)
                SELECT ((s-1) %% 1000)+1, ((s-1) %% 500)+1, CURRENT_DATE - s, ''open'', ''medium''
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- service_order_lines
        tbl := prefix || '_service_order_lines';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            service_line_id SERIAL PRIMARY KEY,
            service_order_id INT REFERENCES %I(service_order_id),
            product_id INT REFERENCES products(product_id),
            qty INT,
            estimated_hours DECIMAL(6,2),
            rate DECIMAL(10,2)
        )', tbl, prefix || '_service_orders');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (service_order_id, product_id, qty, estimated_hours, rate)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 2000)+1, 1 + (s %% 3), 1.5 + s, 85 + (s*2)
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- inspections
        tbl := prefix || '_inspections';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            inspection_id SERIAL PRIMARY KEY,
            service_order_id INT REFERENCES %I(service_order_id),
            inspector_id INT REFERENCES employees(employee_id),
            inspection_date DATE,
            result VARCHAR(20),
            score INT
        )', tbl, prefix || '_service_orders');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (service_order_id, inspector_id, inspection_date, result, score)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 500)+1, CURRENT_DATE - s, ''pass'', 80 + s
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- inspection_items
        tbl := prefix || '_inspection_items';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            inspection_item_id SERIAL PRIMARY KEY,
            inspection_id INT REFERENCES %I(inspection_id),
            product_id INT REFERENCES products(product_id),
            status VARCHAR(20),
            notes TEXT
        )', tbl, prefix || '_inspections');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (inspection_id, product_id, status, notes)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 2000)+1, ''ok'', ''auto-generated''
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- warranties
        tbl := prefix || '_warranties';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            warranty_id SERIAL PRIMARY KEY,
            product_id INT REFERENCES products(product_id),
            customer_id INT REFERENCES customers(customer_id),
            start_date DATE,
            end_date DATE,
            coverage_level VARCHAR(20)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (product_id, customer_id, start_date, end_date, coverage_level)
                SELECT ((s-1) %% 2000)+1, ((s-1) %% 1000)+1,
                       CURRENT_DATE - (s*90), CURRENT_DATE + (s*180), ''standard''
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- returns
        tbl := prefix || '_returns';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            return_id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(customer_id),
            return_date DATE,
            reason VARCHAR(200),
            status VARCHAR(20)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (customer_id, return_date, reason, status)
                SELECT ((s-1) %% 1000)+1, CURRENT_DATE - (s*7), ''defective'', ''approved''
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- return_lines
        tbl := prefix || '_return_lines';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            return_line_id SERIAL PRIMARY KEY,
            return_id INT REFERENCES %I(return_id),
            product_id INT REFERENCES products(product_id),
            qty INT,
            refund_amount DECIMAL(10,2)
        )', tbl, prefix || '_returns');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (return_id, product_id, qty, refund_amount)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 2000)+1, 1 + (s %% 2), 50 + s
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- deliveries
        tbl := prefix || '_deliveries';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            delivery_id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(customer_id),
            scheduled_date DATE,
            delivered_date DATE,
            status VARCHAR(20)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (customer_id, scheduled_date, delivered_date, status)
                SELECT ((s-1) %% 1000)+1, CURRENT_DATE + s, CURRENT_DATE + (s+1), ''shipped''
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- delivery_lines
        tbl := prefix || '_delivery_lines';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            delivery_line_id SERIAL PRIMARY KEY,
            delivery_id INT REFERENCES %I(delivery_id),
            product_id INT REFERENCES products(product_id),
            qty INT,
            shipped_qty INT
        )', tbl, prefix || '_deliveries');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (delivery_id, product_id, qty, shipped_qty)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 2000)+1, 1 + (s %% 4), 1 + (s %% 4)
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- subscriptions
        tbl := prefix || '_subscriptions';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            subscription_id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(customer_id),
            start_date DATE,
            end_date DATE,
            status VARCHAR(20),
            billing_cycle VARCHAR(20)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (customer_id, start_date, end_date, status, billing_cycle)
                SELECT ((s-1) %% 1000)+1, CURRENT_DATE - (s*30), CURRENT_DATE + (s*365), ''active'', ''monthly''
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- subscription_items
        tbl := prefix || '_subscription_items';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            subscription_item_id SERIAL PRIMARY KEY,
            subscription_id INT REFERENCES %I(subscription_id),
            product_id INT REFERENCES products(product_id),
            qty INT,
            unit_price DECIMAL(10,2)
        )', tbl, prefix || '_subscriptions');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (subscription_id, product_id, qty, unit_price)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 2000)+1, 1 + (s %% 3), 25 + s
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- billings
        tbl := prefix || '_billings';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            billing_id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(customer_id),
            billing_date DATE,
            due_date DATE,
            status VARCHAR(20),
            total_amount DECIMAL(12,2)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (customer_id, billing_date, due_date, status, total_amount)
                SELECT ((s-1) %% 1000)+1, CURRENT_DATE - s, CURRENT_DATE + 30, ''open'', 500 + (s*25)
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- billing_lines
        tbl := prefix || '_billing_lines';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            billing_line_id SERIAL PRIMARY KEY,
            billing_id INT REFERENCES %I(billing_id),
            product_id INT REFERENCES products(product_id),
            qty INT,
            amount DECIMAL(12,2)
        )', tbl, prefix || '_billings');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (billing_id, product_id, qty, amount)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 2000)+1, 1 + (s %% 4), 100 + s
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- tasks
        tbl := prefix || '_tasks';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            task_id SERIAL PRIMARY KEY,
            project_id INT REFERENCES projects(project_id),
            assigned_to INT REFERENCES employees(employee_id),
            task_date DATE,
            status VARCHAR(20),
            hours DECIMAL(6,2)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (project_id, assigned_to, task_date, status, hours)
                SELECT ((s-1) %% 100)+1, ((s-1) %% 500)+1, CURRENT_DATE - (s*2), ''open'', 2.5 + s
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- task_assignments
        tbl := prefix || '_task_assignments';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            assignment_id SERIAL PRIMARY KEY,
            task_id INT REFERENCES %I(task_id),
            employee_id INT REFERENCES employees(employee_id),
            assigned_date DATE,
            role VARCHAR(50)
        )', tbl, prefix || '_tasks');
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (task_id, employee_id, assigned_date, role)
                SELECT ((s-1) %% 5)+1, ((s-1) %% 500)+1, CURRENT_DATE - s, ''contributor''
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- kpis
        tbl := prefix || '_kpis';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            kpi_id SERIAL PRIMARY KEY,
            employee_id INT REFERENCES employees(employee_id),
            kpi_date DATE,
            metric_name VARCHAR(100),
            metric_value DECIMAL(12,2)
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (employee_id, kpi_date, metric_name, metric_value)
                SELECT ((s-1) %% 500)+1, CURRENT_DATE - s, ''throughput'', 75 + s
                FROM generate_series(1,5) s', tbl);
        END IF;

        -- notes
        tbl := prefix || '_notes';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            note_id SERIAL PRIMARY KEY,
            entity_type VARCHAR(50),
            entity_id INT,
            author_employee_id INT REFERENCES employees(employee_id),
            note_text TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (entity_type, entity_id, author_employee_id, note_text)
                SELECT ''contract'', ((s-1) %% 5)+1, ((s-1) %% 500)+1, ''auto-generated note''
                FROM generate_series(1,5) s', tbl);
        END IF;
    END LOOP;

    -- Add 15 extra ERP-style misc tables to reach 1,915 additions
    FOR m IN 1..15 LOOP
        prefix := format('xextra_%03s', m);

        tbl := prefix || '_ledger';
        EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
            entry_id SERIAL PRIMARY KEY,
            customer_id INT REFERENCES customers(customer_id),
            owner_employee_id INT REFERENCES employees(employee_id),
            entry_date DATE,
            amount DECIMAL(12,2),
            description TEXT
        )', tbl);
        EXECUTE format('SELECT COUNT(*) FROM %I', tbl) INTO cnt;
        IF cnt = 0 THEN
            EXECUTE format('INSERT INTO %I (customer_id, owner_employee_id, entry_date, amount, description)
                SELECT ((s-1) %% 1000)+1, ((s-1) %% 500)+1, CURRENT_DATE - s, 250 + (s*10), ''misc ledger entry''
                FROM generate_series(1,5) s', tbl);
        END IF;
    END LOOP;
END $$;
