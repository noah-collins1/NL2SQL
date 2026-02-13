#!/usr/bin/env python3
"""
Enterprise ERP Sample Data Generator
Generates realistic sample data for 85-table schema
Target volumes as specified in schema_design.md
"""

import random
import re
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib

# Seed for reproducibility
random.seed(42)

# ============================================
# HELPER FUNCTIONS
# ============================================

def random_date(start_year=2020, end_year=2024):
    """Generate random date within range"""
    start = datetime(start_year, 1, 1)
    end = datetime(end_year, 12, 31)
    delta = end - start
    random_days = random.randint(0, delta.days)
    return (start + timedelta(days=random_days)).strftime('%Y-%m-%d')

def random_recent_date(days_back=365):
    """Generate random recent date"""
    today = datetime(2024, 12, 1)
    delta = timedelta(days=random.randint(0, days_back))
    return (today - delta).strftime('%Y-%m-%d')

def escape_sql(s):
    """Escape single quotes for SQL"""
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"

def sql_val(v):
    """Convert Python value to SQL literal - handles None as NULL"""
    if v is None or v == "NULL":
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)):
        return str(v)
    return escape_sql(v)

def decimal_val(min_val, max_val, decimals=2):
    """Generate random decimal value"""
    val = random.uniform(min_val, max_val)
    return round(val, decimals)

def gen_phone():
    """Generate US phone number"""
    return f"({random.randint(200,999)}) {random.randint(200,999)}-{random.randint(1000,9999)}"

def gen_email(first, last, domain):
    """Generate email from name"""
    return f"{first.lower()}.{last.lower()}@{domain}".replace(' ', '')

_INSERT_RE = re.compile(r'^(INSERT INTO .+ VALUES )(.+);$')

def batch_inserts(sql: str, batch_size: int = 500) -> str:
    """Merge consecutive same-table INSERT statements into multi-row VALUES batches.

    Turns N individual INSERTs into ceil(N/batch_size) multi-row INSERTs,
    which is 10-50x faster for PostgreSQL to execute.
    """
    lines = sql.split('\n')
    output: list[str] = []
    current_prefix: str | None = None
    current_values: list[str] = []

    def flush():
        nonlocal current_prefix, current_values
        if not current_values:
            return
        for i in range(0, len(current_values), batch_size):
            batch = current_values[i:i + batch_size]
            output.append(current_prefix + ',\n'.join(batch) + ';')
        current_prefix = None
        current_values = []

    for line in lines:
        m = _INSERT_RE.match(line)
        if m:
            prefix, values = m.group(1), m.group(2)
            if prefix == current_prefix:
                current_values.append(values)
            else:
                flush()
                current_prefix = prefix
                current_values = [values]
        else:
            flush()
            output.append(line)

    flush()
    return '\n'.join(output)

# ============================================
# DATA LISTS
# ============================================

FIRST_NAMES = [
    "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda",
    "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica",
    "Thomas", "Sarah", "Christopher", "Karen", "Charles", "Lisa", "Daniel", "Nancy",
    "Matthew", "Betty", "Anthony", "Margaret", "Mark", "Sandra", "Donald", "Ashley",
    "Steven", "Kimberly", "Paul", "Emily", "Andrew", "Donna", "Joshua", "Michelle",
    "Kenneth", "Dorothy", "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa",
    "Timothy", "Deborah", "Ronald", "Stephanie", "Edward", "Rebecca", "Jason", "Sharon",
    "Jeffrey", "Laura", "Ryan", "Cynthia", "Jacob", "Kathleen", "Gary", "Amy",
    "Nicholas", "Angela", "Eric", "Shirley", "Jonathan", "Anna", "Stephen", "Brenda",
    "Larry", "Pamela", "Justin", "Emma", "Scott", "Nicole", "Brandon", "Helen",
    "Benjamin", "Samantha", "Samuel", "Katherine", "Raymond", "Christine", "Gregory", "Debra",
    "Frank", "Rachel", "Alexander", "Carolyn", "Patrick", "Janet", "Jack", "Catherine"
]

LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
    "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas",
    "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White",
    "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker", "Young",
    "Allen", "King", "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores",
    "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
    "Carter", "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz", "Parker",
    "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales", "Murphy"
]

COMPANY_PREFIXES = [
    "Global", "Premier", "Advanced", "United", "National", "Pacific", "Atlantic", "Summit",
    "Pinnacle", "Elite", "Prime", "Apex", "Dynamic", "Innovative", "Strategic", "Allied",
    "Central", "Metro", "Capital", "Western", "Eastern", "Northern", "Southern", "Continental"
]

COMPANY_SUFFIXES = [
    "Industries", "Corporation", "Solutions", "Enterprises", "Technologies", "Systems",
    "Group", "Holdings", "Partners", "Associates", "International", "Services", "Dynamics",
    "Innovations", "Manufacturing", "Logistics", "Distribution", "Supply", "Trading", "Consulting"
]

STREET_NAMES = [
    "Main", "Oak", "Maple", "Cedar", "Pine", "Elm", "Washington", "Lake", "Hill", "Park",
    "Market", "Commerce", "Industrial", "Technology", "Innovation", "Enterprise", "Business"
]

STREET_TYPES = ["St", "Ave", "Blvd", "Dr", "Ln", "Way", "Rd", "Pkwy"]

DEPARTMENTS = [
    ("Executive", None, 5000000),
    ("Human Resources", 1, 800000),
    ("Finance", 1, 1200000),
    ("Accounting", 3, 600000),
    ("Information Technology", 1, 2000000),
    ("Software Development", 5, 1500000),
    ("Infrastructure", 5, 800000),
    ("Sales", 1, 3000000),
    ("Sales - North", 8, 1000000),
    ("Sales - South", 8, 1000000),
    ("Sales - West", 8, 1000000),
    ("Marketing", 1, 1500000),
    ("Operations", 1, 2500000),
    ("Manufacturing", 13, 1800000),
    ("Quality Assurance", 13, 400000),
    ("Warehouse", 13, 600000),
    ("Logistics", 13, 500000),
    ("Procurement", 1, 800000),
    ("Customer Service", 1, 700000),
    ("Legal", 1, 500000),
    ("Research & Development", 1, 1200000),
    ("Product Management", 1, 600000),
    ("Project Management", 1, 400000),
    ("Training", 2, 300000),
    ("Facilities", 13, 400000)
]

POSITIONS = [
    ("CEO", 250000, 500000, 1),
    ("CFO", 200000, 400000, 3),
    ("CTO", 200000, 400000, 5),
    ("VP of Sales", 150000, 300000, 8),
    ("VP of Operations", 150000, 300000, 13),
    ("Director of HR", 100000, 180000, 2),
    ("Director of Finance", 100000, 180000, 3),
    ("Director of IT", 100000, 180000, 5),
    ("Director of Marketing", 100000, 180000, 12),
    ("Senior Software Engineer", 90000, 160000, 6),
    ("Software Engineer", 70000, 120000, 6),
    ("Junior Software Engineer", 50000, 80000, 6),
    ("Sales Manager", 80000, 140000, 8),
    ("Sales Representative", 45000, 85000, 8),
    ("Account Executive", 55000, 100000, 8),
    ("Financial Analyst", 60000, 100000, 3),
    ("Accountant", 50000, 85000, 4),
    ("HR Specialist", 45000, 75000, 2),
    ("HR Coordinator", 40000, 60000, 2),
    ("Marketing Manager", 70000, 120000, 12),
    ("Marketing Specialist", 45000, 75000, 12),
    ("Operations Manager", 70000, 120000, 13),
    ("Warehouse Supervisor", 45000, 70000, 16),
    ("Warehouse Associate", 32000, 48000, 16),
    ("Quality Inspector", 40000, 65000, 15),
    ("Procurement Specialist", 50000, 80000, 18),
    ("Customer Service Rep", 35000, 55000, 19),
    ("Project Manager", 75000, 130000, 23),
    ("Business Analyst", 65000, 110000, 23),
    ("Technical Writer", 50000, 80000, 21),
    ("Data Analyst", 60000, 100000, 5),
    ("Network Administrator", 60000, 95000, 7),
    ("System Administrator", 55000, 90000, 7),
    ("Database Administrator", 70000, 120000, 7),
    ("Help Desk Technician", 40000, 60000, 5),
    ("Receptionist", 30000, 45000, 25),
    ("Executive Assistant", 45000, 70000, 1),
    ("Legal Counsel", 100000, 180000, 20),
    ("Paralegal", 45000, 70000, 20),
    ("Training Coordinator", 45000, 70000, 24)
]

PRODUCT_CATEGORIES = [
    ("Electronics", None),
    ("Computers", 1),
    ("Laptops", 2),
    ("Desktops", 2),
    ("Monitors", 2),
    ("Peripherals", 2),
    ("Networking", 1),
    ("Routers", 7),
    ("Switches", 7),
    ("Cables", 7),
    ("Office Supplies", None),
    ("Paper Products", 11),
    ("Writing Instruments", 11),
    ("Filing & Storage", 11),
    ("Furniture", None),
    ("Desks", 15),
    ("Chairs", 15),
    ("Storage Units", 15),
    ("Software", None),
    ("Operating Systems", 19),
    ("Productivity", 19),
    ("Security", 19),
    ("Industrial Equipment", None),
    ("Power Tools", 23),
    ("Hand Tools", 23),
    ("Safety Equipment", 23),
    ("Raw Materials", None),
    ("Metals", 27),
    ("Plastics", 27),
    ("Packaging", 27)
]

COUNTRIES = [
    ("United States", "US", "+1"),
    ("Canada", "CA", "+1"),
    ("United Kingdom", "GB", "+44"),
    ("Germany", "DE", "+49"),
    ("France", "FR", "+33"),
    ("Japan", "JP", "+81"),
    ("Australia", "AU", "+61"),
    ("Mexico", "MX", "+52"),
    ("Brazil", "BR", "+55"),
    ("India", "IN", "+91")
]

US_STATES = [
    ("Alabama", "AL"), ("Alaska", "AK"), ("Arizona", "AZ"), ("Arkansas", "AR"),
    ("California", "CA"), ("Colorado", "CO"), ("Connecticut", "CT"), ("Delaware", "DE"),
    ("Florida", "FL"), ("Georgia", "GA"), ("Hawaii", "HI"), ("Idaho", "ID"),
    ("Illinois", "IL"), ("Indiana", "IN"), ("Iowa", "IA"), ("Kansas", "KS"),
    ("Kentucky", "KY"), ("Louisiana", "LA"), ("Maine", "ME"), ("Maryland", "MD"),
    ("Massachusetts", "MA"), ("Michigan", "MI"), ("Minnesota", "MN"), ("Mississippi", "MS"),
    ("Missouri", "MO"), ("Montana", "MT"), ("Nebraska", "NE"), ("Nevada", "NV"),
    ("New Hampshire", "NH"), ("New Jersey", "NJ"), ("New Mexico", "NM"), ("New York", "NY"),
    ("North Carolina", "NC"), ("North Dakota", "ND"), ("Ohio", "OH"), ("Oklahoma", "OK"),
    ("Oregon", "OR"), ("Pennsylvania", "PA"), ("Rhode Island", "RI"), ("South Carolina", "SC"),
    ("South Dakota", "SD"), ("Tennessee", "TN"), ("Texas", "TX"), ("Utah", "UT"),
    ("Vermont", "VT"), ("Virginia", "VA"), ("Washington", "WA"), ("West Virginia", "WV"),
    ("Wisconsin", "WI"), ("Wyoming", "WY")
]

CITIES_BY_STATE = {
    "CA": [("Los Angeles", "90001"), ("San Francisco", "94102"), ("San Diego", "92101"), ("San Jose", "95101")],
    "TX": [("Houston", "77001"), ("Dallas", "75201"), ("Austin", "78701"), ("San Antonio", "78201")],
    "NY": [("New York", "10001"), ("Buffalo", "14201"), ("Albany", "12201"), ("Rochester", "14601")],
    "FL": [("Miami", "33101"), ("Orlando", "32801"), ("Tampa", "33601"), ("Jacksonville", "32099")],
    "IL": [("Chicago", "60601"), ("Springfield", "62701"), ("Peoria", "61601"), ("Rockford", "61101")],
    "PA": [("Philadelphia", "19101"), ("Pittsburgh", "15201"), ("Harrisburg", "17101"), ("Allentown", "18101")],
    "OH": [("Columbus", "43201"), ("Cleveland", "44101"), ("Cincinnati", "45201"), ("Toledo", "43601")],
    "GA": [("Atlanta", "30301"), ("Savannah", "31401"), ("Augusta", "30901"), ("Macon", "31201")],
    "WA": [("Seattle", "98101"), ("Spokane", "99201"), ("Tacoma", "98401"), ("Bellevue", "98004")],
    "MA": [("Boston", "02101"), ("Worcester", "01601"), ("Springfield", "01101"), ("Cambridge", "02139")]
}

CURRENCIES = [
    ("USD", "US Dollar", "$"),
    ("EUR", "Euro", "€"),
    ("GBP", "British Pound", "£"),
    ("CAD", "Canadian Dollar", "$"),
    ("JPY", "Japanese Yen", "¥"),
    ("AUD", "Australian Dollar", "$"),
    ("MXN", "Mexican Peso", "$"),
    ("BRL", "Brazilian Real", "R$"),
    ("INR", "Indian Rupee", "₹"),
    ("CHF", "Swiss Franc", "CHF")
]

BENEFIT_TYPES = [
    ("Health Insurance - Basic", "Basic health coverage", 6000),
    ("Health Insurance - Premium", "Premium health coverage with dental and vision", 12000),
    ("Dental Insurance", "Standalone dental coverage", 1200),
    ("Vision Insurance", "Vision coverage including glasses/contacts", 600),
    ("Life Insurance", "Term life insurance 2x salary", 1800),
    ("401(k) Match", "Company matches up to 6%", 0),
    ("Disability Insurance", "Short and long term disability", 1500),
    ("Flexible Spending Account", "Pre-tax healthcare spending", 0),
    ("Employee Assistance Program", "Mental health and counseling", 400),
    ("Gym Membership", "Corporate gym membership discount", 600)
]

LEAVE_TYPES = [
    ("Annual Leave", 20, True, True),
    ("Sick Leave", 10, True, False),
    ("Personal Leave", 3, True, True),
    ("Bereavement", 5, True, False),
    ("Jury Duty", 10, True, False),
    ("Parental Leave", 60, True, True),
    ("Unpaid Leave", 30, False, True),
    ("Military Leave", 15, True, False)
]

CERTIFICATIONS = [
    ("PMP", "Project Management Institute", 3),
    ("AWS Solutions Architect", "Amazon Web Services", 3),
    ("CISSP", "ISC2", 3),
    ("CPA", "AICPA", None),
    ("PHR", "HRCI", 3),
    ("SHRM-CP", "SHRM", 3),
    ("Six Sigma Green Belt", "ASQ", None),
    ("Six Sigma Black Belt", "ASQ", None),
    ("ITIL Foundation", "Axelos", 3),
    ("Salesforce Admin", "Salesforce", 1),
    ("Google Cloud Professional", "Google", 2),
    ("Microsoft Azure Admin", "Microsoft", 1),
    ("CompTIA Security+", "CompTIA", 3),
    ("Certified Scrum Master", "Scrum Alliance", 2),
    ("CCNA", "Cisco", 3)
]

TRAINING_COURSES = [
    ("New Employee Orientation", "Mandatory onboarding for all new hires", 8, 0, True),
    ("Safety Training", "Workplace safety fundamentals", 4, 0, True),
    ("Sexual Harassment Prevention", "Required compliance training", 2, 0, True),
    ("Leadership Development", "Building leadership skills", 16, 2500, False),
    ("Project Management Basics", "Introduction to PM methodology", 8, 800, False),
    ("Excel Advanced", "Advanced spreadsheet techniques", 8, 400, False),
    ("SQL Fundamentals", "Database query basics", 16, 600, False),
    ("Python Programming", "Introduction to Python", 24, 1200, False),
    ("Public Speaking", "Effective presentation skills", 8, 500, False),
    ("Time Management", "Productivity and prioritization", 4, 300, False),
    ("Customer Service Excellence", "Best practices for customer interactions", 8, 400, False),
    ("Conflict Resolution", "Managing workplace conflicts", 4, 350, False),
    ("Data Privacy & Security", "Protecting sensitive information", 2, 0, True),
    ("First Aid & CPR", "Emergency response training", 8, 150, False),
    ("Agile Methodology", "Scrum and agile practices", 16, 900, False)
]

ACCOUNT_TYPES = [
    ("Cash and Equivalents", "asset", "debit"),
    ("Accounts Receivable", "asset", "debit"),
    ("Inventory", "asset", "debit"),
    ("Prepaid Expenses", "asset", "debit"),
    ("Fixed Assets", "asset", "debit"),
    ("Accumulated Depreciation", "asset", "credit"),
    ("Accounts Payable", "liability", "credit"),
    ("Accrued Liabilities", "liability", "credit"),
    ("Notes Payable", "liability", "credit"),
    ("Long-term Debt", "liability", "credit"),
    ("Common Stock", "equity", "credit"),
    ("Retained Earnings", "equity", "credit"),
    ("Sales Revenue", "revenue", "credit"),
    ("Service Revenue", "revenue", "credit"),
    ("Interest Income", "revenue", "credit"),
    ("Cost of Goods Sold", "expense", "debit"),
    ("Salaries Expense", "expense", "debit"),
    ("Rent Expense", "expense", "debit"),
    ("Utilities Expense", "expense", "debit"),
    ("Depreciation Expense", "expense", "debit"),
    ("Marketing Expense", "expense", "debit"),
    ("Office Expense", "expense", "debit"),
    ("Travel Expense", "expense", "debit"),
    ("Insurance Expense", "expense", "debit"),
    ("Interest Expense", "expense", "debit")
]

OPPORTUNITY_STAGES = [
    ("Lead", 1, 10, False, False),
    ("Qualified", 2, 25, False, False),
    ("Proposal", 3, 50, False, False),
    ("Negotiation", 4, 75, False, False),
    ("Closed Won", 5, 100, True, True),
    ("Closed Lost", 6, 0, True, False)
]

WAREHOUSES = [
    ("Main Distribution Center", 1),
    ("East Coast Warehouse", 2),
    ("West Coast Warehouse", 3),
    ("Southern Hub", 4),
    ("Manufacturing Warehouse", 5)
]

ASSET_CATEGORIES = [
    ("Computer Equipment", "straight-line", 5),
    ("Office Furniture", "straight-line", 7),
    ("Vehicles", "declining-balance", 5),
    ("Manufacturing Equipment", "straight-line", 10),
    ("Buildings", "straight-line", 39),
    ("Software", "straight-line", 3),
    ("Leasehold Improvements", "straight-line", 10)
]

MAINTENANCE_TYPES = [
    ("Preventive Maintenance", "Scheduled routine maintenance", 3),
    ("Corrective Maintenance", "Repair of malfunctions", None),
    ("Calibration", "Equipment calibration", 12),
    ("Safety Inspection", "Safety compliance check", 12),
    ("Software Update", "System software updates", 6),
    ("Deep Cleaning", "Thorough cleaning service", 6)
]

# ============================================
# SQL GENERATION FUNCTIONS
# ============================================

def generate_sql():
    """Generate all INSERT statements"""
    sql_parts = []

    sql_parts.append("-- Enterprise ERP Sample Data")
    sql_parts.append("-- Generated for NL2SQL testing")
    sql_parts.append("-- Auto-generated - do not edit manually")
    sql_parts.append("")
    sql_parts.append("")
    sql_parts.append("")

    # Track IDs for foreign keys
    state_ids = {}
    city_ids = {}
    address_ids = []
    employee_ids = []
    customer_ids = []
    vendor_ids = []
    product_ids = []

    # ========== COMMON MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- COMMON/LOOKUP MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Countries
    sql_parts.append("-- Countries")
    for i, (name, iso, phone) in enumerate(COUNTRIES, 1):
        sql_parts.append(f"INSERT INTO countries (country_id, name, iso_code, phone_code) VALUES ({i}, {escape_sql(name)}, {escape_sql(iso)}, {escape_sql(phone)});")
    sql_parts.append("")

    # States (US only for simplicity)
    sql_parts.append("-- States/Provinces")
    state_id = 1
    for name, abbrev in US_STATES:
        sql_parts.append(f"INSERT INTO states_provinces (state_id, country_id, name, abbreviation) VALUES ({state_id}, 1, {escape_sql(name)}, {escape_sql(abbrev)});")
        state_ids[abbrev] = state_id
        state_id += 1
    sql_parts.append("")

    # Cities
    sql_parts.append("-- Cities")
    city_id = 1
    for state_abbrev, cities in CITIES_BY_STATE.items():
        if state_abbrev in state_ids:
            for city_name, postal in cities:
                sql_parts.append(f"INSERT INTO cities (city_id, state_id, name, postal_code) VALUES ({city_id}, {state_ids[state_abbrev]}, {escape_sql(city_name)}, {escape_sql(postal)});")
                city_ids[(state_abbrev, city_name)] = city_id
                city_id += 1
    sql_parts.append("")

    # Currencies
    sql_parts.append("-- Currencies")
    for i, (code, name, symbol) in enumerate(CURRENCIES, 1):
        exchange = 1.0 if code == "USD" else decimal_val(0.5, 1.5, 4)
        sql_parts.append(f"INSERT INTO currencies (currency_id, code, name, symbol, exchange_rate) VALUES ({i}, {escape_sql(code)}, {escape_sql(name)}, {escape_sql(symbol)}, {exchange});")
    sql_parts.append("")

    # Addresses (generate 2000 for various entities)
    sql_parts.append("-- Addresses")
    all_cities = list(city_ids.keys())
    for i in range(1, 2001):
        street_num = random.randint(100, 9999)
        street = f"{street_num} {random.choice(STREET_NAMES)} {random.choice(STREET_TYPES)}"
        city_key = random.choice(all_cities)
        cid = city_ids[city_key]
        postal = f"{random.randint(10000, 99999)}"
        sql_parts.append(f"INSERT INTO addresses (address_id, street1, city_id, postal_code) VALUES ({i}, {escape_sql(street)}, {cid}, {escape_sql(postal)});")
        address_ids.append(i)
    sql_parts.append("")

    # ========== HR MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- HR MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Departments
    sql_parts.append("-- Departments")
    for i, (name, parent, budget) in enumerate(DEPARTMENTS, 1):
        parent_val = parent if parent else "NULL"
        sql_parts.append(f"INSERT INTO departments (department_id, name, parent_department_id, budget) VALUES ({i}, {escape_sql(name)}, {parent_val}, {budget});")
    sql_parts.append("")

    # Positions
    sql_parts.append("-- Positions")
    for i, (title, min_sal, max_sal, dept) in enumerate(POSITIONS, 1):
        sql_parts.append(f"INSERT INTO positions (position_id, title, min_salary, max_salary, department_id) VALUES ({i}, {escape_sql(title)}, {min_sal}, {max_sal}, {dept});")
    sql_parts.append("")

    # Employees (500)
    sql_parts.append("-- Employees")
    used_emails = set()
    for i in range(1, 501):
        first = random.choice(FIRST_NAMES)
        last = random.choice(LAST_NAMES)
        emp_num = f"EMP{i:05d}"

        # Ensure unique email
        base_email = gen_email(first, last, "company.com")
        email = base_email
        counter = 1
        while email in used_emails:
            email = f"{first.lower()}.{last.lower()}{counter}@company.com".replace(' ', '')
            counter += 1
        used_emails.add(email)

        phone = gen_phone()

        # Assign position and department
        if i <= 3:  # Executives
            pos_id = i
            dept_id = POSITIONS[i-1][3]
        else:
            pos_id = random.randint(4, len(POSITIONS))
            dept_id = POSITIONS[pos_id-1][3]

        # Manager (executives report to CEO, others to someone senior)
        if i == 1:
            manager = "NULL"
        elif i <= 5:
            manager = 1
        else:
            manager = random.randint(1, min(i-1, 50))

        # Salary within position range
        pos = POSITIONS[pos_id-1]
        salary = decimal_val(pos[1], pos[2])

        hire_date = random_date(2018, 2024)
        birth_date = random_date(1960, 2000)
        gender = random.choice(["Male", "Female", "Non-binary"])
        addr_id = random.choice(address_ids[:500])

        sql_parts.append(f"INSERT INTO employees (employee_id, employee_number, first_name, last_name, email, phone, department_id, position_id, manager_id, hire_date, salary, address_id, birth_date, gender) VALUES ({i}, {escape_sql(emp_num)}, {escape_sql(first)}, {escape_sql(last)}, {escape_sql(email)}, {escape_sql(phone)}, {dept_id}, {pos_id}, {manager}, {escape_sql(hire_date)}, {salary}, {addr_id}, {escape_sql(birth_date)}, {escape_sql(gender)});")
        employee_ids.append(i)
    sql_parts.append("")

    # Update department managers
    sql_parts.append("-- Update department managers")
    for i in range(1, len(DEPARTMENTS) + 1):
        manager_id = random.randint(1, 50)  # Senior employees
        sql_parts.append(f"UPDATE departments SET manager_id = {manager_id} WHERE department_id = {i};")
    sql_parts.append("")

    # Business Units
    sql_parts.append("-- Business Units")
    units = [
        ("Corporate", None, 1),
        ("North America Operations", 1, 5),
        ("Europe Operations", 1, 10),
        ("Asia Pacific Operations", 1, 15),
        ("Manufacturing Division", 1, 20)
    ]
    for i, (name, parent, mgr) in enumerate(units, 1):
        parent_val = parent if parent else "NULL"
        sql_parts.append(f"INSERT INTO business_units (unit_id, name, parent_unit_id, manager_id) VALUES ({i}, {escape_sql(name)}, {parent_val}, {mgr});")
    sql_parts.append("")

    # Cost Centers
    sql_parts.append("-- Cost Centers")
    for i in range(1, 26):
        code = f"CC{i:03d}"
        name = f"Cost Center - {DEPARTMENTS[i-1][0]}" if i <= len(DEPARTMENTS) else f"Cost Center {i}"
        dept = i if i <= len(DEPARTMENTS) else random.randint(1, len(DEPARTMENTS))
        sql_parts.append(f"INSERT INTO cost_centers (cost_center_id, code, name, department_id) VALUES ({i}, {escape_sql(code)}, {escape_sql(name)}, {dept});")
    sql_parts.append("")

    # Benefit Types
    sql_parts.append("-- Benefit Types")
    for i, (name, desc, cost) in enumerate(BENEFIT_TYPES, 1):
        sql_parts.append(f"INSERT INTO benefit_types (benefit_type_id, name, description, annual_cost) VALUES ({i}, {escape_sql(name)}, {escape_sql(desc)}, {cost});")
    sql_parts.append("")

    # Employee Benefits (most employees have benefits)
    sql_parts.append("-- Employee Benefits")
    benefit_id = 1
    for emp_id in employee_ids:
        # Each employee gets 2-5 benefits
        num_benefits = random.randint(2, 5)
        selected = random.sample(range(1, len(BENEFIT_TYPES) + 1), num_benefits)
        for bt_id in selected:
            start = random_date(2020, 2024)
            sql_parts.append(f"INSERT INTO employee_benefits (benefit_id, employee_id, benefit_type_id, start_date, coverage_level) VALUES ({benefit_id}, {emp_id}, {bt_id}, {escape_sql(start)}, {escape_sql(random.choice(['Individual', 'Family', 'Employee+Spouse']))});")
            benefit_id += 1
    sql_parts.append("")

    # Leave Types
    sql_parts.append("-- Leave Types")
    for i, (name, days, paid, approval) in enumerate(LEAVE_TYPES, 1):
        sql_parts.append(f"INSERT INTO leave_types (leave_type_id, name, days_allowed, is_paid, requires_approval) VALUES ({i}, {escape_sql(name)}, {days}, {str(paid).upper()}, {str(approval).upper()});")
    sql_parts.append("")

    # Leave Requests (1000)
    sql_parts.append("-- Leave Requests")
    for i in range(1, 1001):
        emp_id = random.choice(employee_ids)
        leave_type = random.randint(1, len(LEAVE_TYPES))
        start = random_date(2023, 2024)
        days = random.randint(1, 5)
        end = (datetime.strptime(start, '%Y-%m-%d') + timedelta(days=days)).strftime('%Y-%m-%d')
        status = random.choice(['pending', 'approved', 'denied', 'completed'])
        approver = random.randint(1, 50) if status != 'pending' else "NULL"
        sql_parts.append(f"INSERT INTO leave_requests (leave_id, employee_id, leave_type_id, start_date, end_date, days_requested, status, approved_by) VALUES ({i}, {emp_id}, {leave_type}, {escape_sql(start)}, {escape_sql(end)}, {days}, {escape_sql(status)}, {approver});")
    sql_parts.append("")

    # Certifications
    sql_parts.append("-- Certifications")
    for i, (name, issuer, years) in enumerate(CERTIFICATIONS, 1):
        years_val = years if years else "NULL"
        sql_parts.append(f"INSERT INTO certifications (certification_id, name, issuing_body, validity_years) VALUES ({i}, {escape_sql(name)}, {escape_sql(issuer)}, {years_val});")
    sql_parts.append("")

    # Employee Certifications (200)
    sql_parts.append("-- Employee Certifications")
    for i in range(1, 201):
        emp_id = random.choice(employee_ids)
        cert_id = random.randint(1, len(CERTIFICATIONS))
        obtained = random_date(2018, 2024)
        cert = CERTIFICATIONS[cert_id - 1]
        if cert[2]:
            expiry = (datetime.strptime(obtained, '%Y-%m-%d') + timedelta(days=cert[2]*365)).strftime('%Y-%m-%d')
            expiry_val = escape_sql(expiry)
        else:
            expiry_val = "NULL"
        cert_num = f"CERT{random.randint(100000, 999999)}"
        sql_parts.append(f"INSERT INTO employee_certifications (cert_id, employee_id, certification_id, obtained_date, expiry_date, certificate_number) VALUES ({i}, {emp_id}, {cert_id}, {escape_sql(obtained)}, {expiry_val}, {escape_sql(cert_num)});")
    sql_parts.append("")

    # Performance Reviews (800)
    sql_parts.append("-- Performance Reviews")
    for i in range(1, 801):
        emp_id = random.choice(employee_ids)
        reviewer_id = random.randint(1, 50)
        year = random.randint(2021, 2024)
        review_date = f"{year}-12-15"
        period_start = f"{year}-01-01"
        period_end = f"{year}-12-31"
        rating = random.randint(1, 5)
        goals_met = random.randint(50, 100)
        sql_parts.append(f"INSERT INTO performance_reviews (review_id, employee_id, reviewer_id, review_period_start, review_period_end, review_date, rating, goals_met_percent) VALUES ({i}, {emp_id}, {reviewer_id}, {escape_sql(period_start)}, {escape_sql(period_end)}, {escape_sql(review_date)}, {rating}, {goals_met});")
    sql_parts.append("")

    # Training Courses
    sql_parts.append("-- Training Courses")
    for i, (name, desc, hours, cost, mandatory) in enumerate(TRAINING_COURSES, 1):
        sql_parts.append(f"INSERT INTO training_courses (course_id, name, description, duration_hours, cost, is_mandatory) VALUES ({i}, {escape_sql(name)}, {escape_sql(desc)}, {hours}, {cost}, {str(mandatory).upper()});")
    sql_parts.append("")

    # Employee Training (1500)
    sql_parts.append("-- Employee Training")
    for i in range(1, 1501):
        emp_id = random.choice(employee_ids)
        course_id = random.randint(1, len(TRAINING_COURSES))
        scheduled = random_date(2022, 2024)
        status = random.choice(['scheduled', 'completed', 'cancelled'])
        if status == 'completed':
            completion = scheduled
            score = random.randint(70, 100)
        else:
            completion = None
            score = "NULL"
        sql_parts.append(f"INSERT INTO employee_training (training_id, employee_id, course_id, scheduled_date, completion_date, score, status) VALUES ({i}, {emp_id}, {course_id}, {sql_val(scheduled)}, {sql_val(completion)}, {score}, {sql_val(status)});")
    sql_parts.append("")

    # Emergency Contacts (700)
    sql_parts.append("-- Emergency Contacts")
    relationships = ["Spouse", "Parent", "Sibling", "Child", "Friend", "Partner"]
    for i in range(1, 701):
        emp_id = random.choice(employee_ids)
        name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
        rel = random.choice(relationships)
        phone = gen_phone()
        is_primary = "TRUE" if i % 3 == 0 else "FALSE"
        sql_parts.append(f"INSERT INTO emergency_contacts (contact_id, employee_id, name, relationship, phone, is_primary) VALUES ({i}, {emp_id}, {escape_sql(name)}, {escape_sql(rel)}, {escape_sql(phone)}, {is_primary});")
    sql_parts.append("")

    # Employment History (400)
    sql_parts.append("-- Employment History")
    companies = [f"{random.choice(COMPANY_PREFIXES)} {random.choice(COMPANY_SUFFIXES)}" for _ in range(50)]
    for i in range(1, 401):
        emp_id = random.choice(employee_ids)
        company = random.choice(companies)
        position = random.choice([p[0] for p in POSITIONS])
        start = random_date(2010, 2018)
        end = random_date(2018, 2022)
        reason = random.choice(["Career advancement", "Relocation", "Better opportunity", "Company downsizing", "Contract ended"])
        sql_parts.append(f"INSERT INTO employment_history (history_id, employee_id, company_name, position, start_date, end_date, reason_for_leaving) VALUES ({i}, {emp_id}, {escape_sql(company)}, {escape_sql(position)}, {escape_sql(start)}, {escape_sql(end)}, {escape_sql(reason)});")
    sql_parts.append("")

    # Employee Salaries (salary history - 1000)
    sql_parts.append("-- Employee Salaries (history)")
    sal_id = 1
    for emp_id in random.sample(employee_ids, 300):
        # Each selected employee gets 2-4 salary records
        for j in range(random.randint(2, 4)):
            year = 2020 + j
            amount = decimal_val(40000, 200000)
            effective = f"{year}-01-01"
            end_date = f"{year}-12-31" if j < 3 else None
            reason = random.choice(["Annual raise", "Promotion", "Market adjustment", "Performance bonus"])
            approver = random.randint(1, 50)
            sql_parts.append(f"INSERT INTO employee_salaries (salary_id, employee_id, amount, effective_date, end_date, change_reason, approved_by) VALUES ({sal_id}, {emp_id}, {amount}, {sql_val(effective)}, {sql_val(end_date)}, {sql_val(reason)}, {approver});")
            sal_id += 1
    sql_parts.append("")

    # ========== FINANCE MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- FINANCE MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Account Types
    sql_parts.append("-- Account Types")
    for i, (name, category, balance) in enumerate(ACCOUNT_TYPES, 1):
        sql_parts.append(f"INSERT INTO account_types (type_id, name, category, normal_balance) VALUES ({i}, {escape_sql(name)}, {escape_sql(category)}, {escape_sql(balance)});")
    sql_parts.append("")

    # Chart of Accounts (50 accounts)
    sql_parts.append("-- Chart of Accounts")
    accounts = [
        ("1000", "Cash", 1), ("1010", "Petty Cash", 1), ("1100", "Accounts Receivable", 2),
        ("1200", "Inventory", 3), ("1300", "Prepaid Insurance", 4), ("1310", "Prepaid Rent", 4),
        ("1500", "Land", 5), ("1510", "Buildings", 5), ("1520", "Equipment", 5),
        ("1530", "Vehicles", 5), ("1540", "Furniture", 5), ("1600", "Accumulated Depreciation - Buildings", 6),
        ("1610", "Accumulated Depreciation - Equipment", 6), ("2000", "Accounts Payable", 7),
        ("2100", "Accrued Salaries", 8), ("2110", "Accrued Interest", 8), ("2200", "Notes Payable", 9),
        ("2500", "Long-term Debt", 10), ("3000", "Common Stock", 11), ("3100", "Retained Earnings", 12),
        ("4000", "Product Sales", 13), ("4100", "Service Revenue", 14), ("4200", "Interest Income", 15),
        ("5000", "Cost of Goods Sold", 16), ("6000", "Salaries Expense", 17), ("6100", "Rent Expense", 18),
        ("6200", "Utilities Expense", 19), ("6300", "Depreciation Expense", 20), ("6400", "Marketing Expense", 21),
        ("6500", "Office Supplies Expense", 22), ("6600", "Travel Expense", 23), ("6700", "Insurance Expense", 24),
        ("6800", "Interest Expense", 25)
    ]
    for i, (num, name, type_id) in enumerate(accounts, 1):
        sql_parts.append(f"INSERT INTO chart_of_accounts (account_id, account_number, name, account_type_id) VALUES ({i}, {escape_sql(num)}, {escape_sql(name)}, {type_id});")
    sql_parts.append("")

    # Fiscal Years
    sql_parts.append("-- Fiscal Years")
    for i, year in enumerate([2022, 2023, 2024, 2025], 1):
        is_closed = "TRUE" if year < 2024 else "FALSE"
        sql_parts.append(f"INSERT INTO fiscal_years (fiscal_year_id, year, start_date, end_date, is_closed) VALUES ({i}, {year}, '{year}-01-01', '{year}-12-31', {is_closed});")
    sql_parts.append("")

    # Fiscal Periods
    sql_parts.append("-- Fiscal Periods")
    period_id = 1
    months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    for fy_id in range(1, 5):
        year = 2021 + fy_id
        for month in range(1, 13):
            is_closed = "TRUE" if year < 2024 or (year == 2024 and month < 12) else "FALSE"
            days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month-1]
            sql_parts.append(f"INSERT INTO fiscal_periods (period_id, fiscal_year_id, period_number, name, start_date, end_date, is_closed) VALUES ({period_id}, {fy_id}, {month}, {escape_sql(months[month-1])}, '{year}-{month:02d}-01', '{year}-{month:02d}-{days_in_month}', {is_closed});")
            period_id += 1
    sql_parts.append("")

    # Tax Rates
    sql_parts.append("-- Tax Rates")
    taxes = [
        ("Sales Tax - CA", 7.25, 1), ("Sales Tax - TX", 6.25, 1), ("Sales Tax - NY", 8.0, 1),
        ("VAT - UK", 20.0, 3), ("VAT - DE", 19.0, 4), ("GST - AU", 10.0, 7),
        ("Corporate Tax - US", 21.0, 1), ("Payroll Tax - US", 7.65, 1)
    ]
    for i, (name, rate, country) in enumerate(taxes, 1):
        sql_parts.append(f"INSERT INTO tax_rates (tax_rate_id, name, rate, country_id) VALUES ({i}, {escape_sql(name)}, {rate}, {country});")
    sql_parts.append("")

    # Bank Accounts
    sql_parts.append("-- Bank Accounts")
    banks = [
        ("Operating Account", "Chase Bank", 1, 1, 2500000),
        ("Payroll Account", "Chase Bank", 1, 1, 800000),
        ("Savings Account", "Bank of America", 1, 1, 5000000),
        ("Euro Account", "Deutsche Bank", 2, 4, 500000),
        ("GBP Account", "Barclays", 3, 3, 300000)
    ]
    for i, (name, bank, curr, gl_acct, balance) in enumerate(banks, 1):
        acct_num = f"{random.randint(1000, 9999)}{random.randint(100000, 999999)}"
        sql_parts.append(f"INSERT INTO bank_accounts (bank_account_id, account_number, account_name, bank_name, currency_id, gl_account_id, current_balance) VALUES ({i}, {escape_sql(acct_num)}, {escape_sql(name)}, {escape_sql(bank)}, {curr}, {gl_acct}, {balance});")
    sql_parts.append("")

    # Bank Transactions (2000)
    sql_parts.append("-- Bank Transactions")
    trans_types = ['deposit', 'withdrawal', 'transfer', 'fee', 'interest']
    for i in range(1, 2001):
        bank_id = random.randint(1, 5)
        trans_date = random_date(2023, 2024)
        trans_type = random.choice(trans_types)
        if trans_type in ['deposit', 'interest']:
            amount = decimal_val(100, 100000)
        elif trans_type == 'fee':
            amount = -decimal_val(5, 100)
        else:
            amount = -decimal_val(100, 50000)
        ref = f"REF{random.randint(100000, 999999)}"
        sql_parts.append(f"INSERT INTO bank_transactions (transaction_id, bank_account_id, transaction_date, amount, transaction_type, reference) VALUES ({i}, {bank_id}, {escape_sql(trans_date)}, {amount}, {escape_sql(trans_type)}, {escape_sql(ref)});")
    sql_parts.append("")

    # Journal Entries (10000)
    sql_parts.append("-- Journal Entries")
    for i in range(1, 10001):
        entry_num = f"JE{i:06d}"
        entry_date = random_date(2022, 2024)
        year = int(entry_date[:4])
        month = int(entry_date[5:7])
        fy_id = year - 2021
        period_id = (fy_id - 1) * 12 + month
        posted_by = random.choice(employee_ids[:50])
        status = random.choice(['draft', 'posted', 'posted', 'posted'])  # Most are posted
        desc = random.choice([
            "Monthly payroll entry", "Vendor payment", "Customer receipt", "Depreciation",
            "Accruals adjustment", "Revenue recognition", "Expense reclass", "Inventory adjustment"
        ])
        sql_parts.append(f"INSERT INTO journal_entries (entry_id, entry_number, entry_date, period_id, description, posted_by, status) VALUES ({i}, {escape_sql(entry_num)}, {escape_sql(entry_date)}, {period_id}, {escape_sql(desc)}, {posted_by}, {escape_sql(status)});")
    sql_parts.append("")

    # Journal Lines (30000 - avg 3 lines per entry)
    sql_parts.append("-- Journal Lines")
    line_id = 1
    for entry_id in range(1, 10001):
        # Each entry has 2-4 lines that balance
        num_lines = random.randint(2, 4)
        total = decimal_val(100, 50000)

        # First half are debits
        debit_lines = num_lines // 2 or 1
        credit_lines = num_lines - debit_lines

        debit_accts = random.sample(range(1, len(accounts) + 1), debit_lines)
        credit_accts = random.sample(range(1, len(accounts) + 1), credit_lines)

        # Distribute total among debit lines
        remaining = total
        for j, acct in enumerate(debit_accts):
            if j == len(debit_accts) - 1:
                amt = remaining
            else:
                amt = round(total / len(debit_accts), 2)
                remaining -= amt
            cc_id = random.randint(1, 25)
            sql_parts.append(f"INSERT INTO journal_lines (line_id, entry_id, account_id, debit, credit, cost_center_id) VALUES ({line_id}, {entry_id}, {acct}, {amt}, 0, {cc_id});")
            line_id += 1

        # Credit lines
        remaining = total
        for j, acct in enumerate(credit_accts):
            if j == len(credit_accts) - 1:
                amt = remaining
            else:
                amt = round(total / len(credit_accts), 2)
                remaining -= amt
            cc_id = random.randint(1, 25)
            sql_parts.append(f"INSERT INTO journal_lines (line_id, entry_id, account_id, debit, credit, cost_center_id) VALUES ({line_id}, {entry_id}, {acct}, 0, {amt}, {cc_id});")
            line_id += 1
    sql_parts.append("")

    # Budgets (50)
    sql_parts.append("-- Budgets")
    for i in range(1, 51):
        fy_id = random.randint(3, 4)  # 2024-2025
        dept_id = random.randint(1, len(DEPARTMENTS))
        name = f"FY{2021 + fy_id} - {DEPARTMENTS[dept_id-1][0]} Budget"
        total = decimal_val(100000, 2000000)
        status = random.choice(['draft', 'approved', 'approved'])
        approver = random.randint(1, 20) if status == 'approved' else "NULL"
        sql_parts.append(f"INSERT INTO budgets (budget_id, fiscal_year_id, department_id, name, total_amount, status, approved_by) VALUES ({i}, {fy_id}, {dept_id}, {escape_sql(name)}, {total}, {escape_sql(status)}, {approver});")
    sql_parts.append("")

    # Budget Lines (200)
    sql_parts.append("-- Budget Lines")
    for i in range(1, 201):
        budget_id = random.randint(1, 50)
        acct_id = random.randint(1, len(accounts))
        period_id = random.randint(25, 48)  # 2024 periods
        amount = decimal_val(5000, 100000)
        sql_parts.append(f"INSERT INTO budget_lines (line_id, budget_id, account_id, period_id, amount) VALUES ({i}, {budget_id}, {acct_id}, {period_id}, {amount});")
    sql_parts.append("")

    # ========== INVENTORY MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- INVENTORY MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Product Categories
    sql_parts.append("-- Product Categories")
    for i, (name, parent) in enumerate(PRODUCT_CATEGORIES, 1):
        parent_val = parent if parent else "NULL"
        sql_parts.append(f"INSERT INTO product_categories (category_id, name, parent_category_id) VALUES ({i}, {escape_sql(name)}, {parent_val});")
    sql_parts.append("")

    # Units of Measure
    sql_parts.append("-- Units of Measure")
    uoms = [
        ("Each", "EA", None, 1), ("Dozen", "DZ", 1, 12), ("Case", "CS", 1, 24),
        ("Pound", "LB", None, 1), ("Ounce", "OZ", 4, 0.0625), ("Kilogram", "KG", 4, 2.205),
        ("Foot", "FT", None, 1), ("Inch", "IN", 7, 0.0833), ("Meter", "M", 7, 3.281),
        ("Gallon", "GAL", None, 1), ("Liter", "L", 10, 0.264)
    ]
    for i, (name, abbr, base, conv) in enumerate(uoms, 1):
        base_val = base if base else "NULL"
        sql_parts.append(f"INSERT INTO units_of_measure (uom_id, name, abbreviation, base_uom_id, conversion_factor) VALUES ({i}, {escape_sql(name)}, {escape_sql(abbr)}, {base_val}, {conv});")
    sql_parts.append("")

    # Products (2000)
    sql_parts.append("-- Products")
    product_names = [
        "Laptop", "Desktop", "Monitor", "Keyboard", "Mouse", "Headset", "Webcam", "Router",
        "Switch", "Cable", "Paper", "Pen", "Notebook", "Folder", "Desk", "Chair",
        "Cabinet", "Shelf", "Software License", "Security Suite", "Power Tool", "Hand Tool",
        "Safety Helmet", "Steel Sheet", "Plastic Pellets", "Cardboard Box"
    ]
    for i in range(1, 2001):
        sku = f"SKU{i:05d}"
        base_name = random.choice(product_names)
        name = f"{base_name} - Model {chr(65 + (i % 26))}{i % 100}"
        category = random.randint(1, len(PRODUCT_CATEGORIES))
        uom = random.randint(1, 5)
        unit_cost = decimal_val(5, 500, 4)
        list_price = round(unit_cost * random.uniform(1.2, 2.5), 2)
        weight = decimal_val(0.1, 50)
        sql_parts.append(f"INSERT INTO products (product_id, sku, name, category_id, uom_id, unit_cost, list_price, weight) VALUES ({i}, {escape_sql(sku)}, {escape_sql(name)}, {category}, {uom}, {unit_cost}, {list_price}, {weight});")
        product_ids.append(i)
    sql_parts.append("")

    # Warehouses
    sql_parts.append("-- Warehouses")
    warehouse_codes = ["MDC", "ECW", "WCW", "SHB", "MFW"]
    for i, (name, addr_offset) in enumerate(WAREHOUSES, 1):
        addr = 500 + i
        code = warehouse_codes[i-1]
        sql_parts.append(f"INSERT INTO warehouses (warehouse_id, code, name, address_id, manager_id) VALUES ({i}, {sql_val(code)}, {sql_val(name)}, {addr}, {random.randint(1, 50)});")
    sql_parts.append("")

    # Warehouse Locations (100)
    sql_parts.append("-- Warehouse Locations")
    loc_id = 1
    for wh_id in range(1, 6):
        for aisle in ['A', 'B', 'C', 'D']:
            for rack in range(1, 6):
                for bin_num in range(1, 2):
                    capacity = random.randint(100, 1000)
                    sql_parts.append(f"INSERT INTO warehouse_locations (location_id, warehouse_id, aisle, rack, bin, capacity) VALUES ({loc_id}, {wh_id}, {escape_sql(aisle)}, {rack}, {bin_num}, {capacity});")
                    loc_id += 1
    sql_parts.append("")

    # Inventory Levels (4000)
    sql_parts.append("-- Inventory Levels")
    level_id = 1
    for product_id in random.sample(product_ids, min(800, len(product_ids))):
        # Each product in 1-5 warehouses
        for wh_id in random.sample(range(1, 6), random.randint(1, 5)):
            loc_id = (wh_id - 1) * 20 + random.randint(1, 20)
            qty = random.randint(0, 500)
            sql_parts.append(f"INSERT INTO inventory_levels (level_id, product_id, warehouse_id, location_id, quantity_on_hand) VALUES ({level_id}, {product_id}, {wh_id}, {loc_id}, {qty});")
            level_id += 1
    sql_parts.append("")

    # Inventory Transactions (5000)
    sql_parts.append("-- Inventory Transactions")
    trans_types = ['receipt', 'shipment', 'adjustment', 'transfer_in', 'transfer_out']
    for i in range(1, 5001):
        prod_id = random.choice(product_ids)
        wh_id = random.randint(1, 5)
        trans_type = random.choice(trans_types)
        qty = random.randint(-50, 100) if trans_type == 'adjustment' else random.randint(1, 100)
        trans_date = random_date(2023, 2024)
        sql_parts.append(f"INSERT INTO inventory_transactions (transaction_id, product_id, warehouse_id, transaction_type, quantity, transaction_date) VALUES ({i}, {prod_id}, {wh_id}, {sql_val(trans_type)}, {qty}, {sql_val(trans_date)});")
    sql_parts.append("")

    # Stock Transfers (200)
    sql_parts.append("-- Stock Transfers")
    for i in range(1, 201):
        from_wh = random.randint(1, 5)
        to_wh = random.choice([w for w in range(1, 6) if w != from_wh])
        status = random.choice(['pending', 'in_transit', 'completed'])
        trans_date = random_date(2023, 2024)
        transfer_number = f"ST-{i:05d}"
        sql_parts.append(f"INSERT INTO stock_transfers (transfer_id, transfer_number, from_warehouse_id, to_warehouse_id, status, transfer_date) VALUES ({i}, {escape_sql(transfer_number)}, {from_wh}, {to_wh}, {escape_sql(status)}, {escape_sql(trans_date)});")
    sql_parts.append("")

    # Transfer Lines (500)
    sql_parts.append("-- Transfer Lines")
    for i in range(1, 501):
        transfer_id = random.randint(1, 200)
        prod_id = random.choice(product_ids)
        qty = random.randint(1, 50)
        sql_parts.append(f"INSERT INTO transfer_lines (line_id, transfer_id, product_id, quantity_requested) VALUES ({i}, {transfer_id}, {prod_id}, {qty});")
    sql_parts.append("")

    # Inventory Adjustments (100)
    sql_parts.append("-- Inventory Adjustments")
    reasons = ['Cycle count', 'Damage', 'Theft', 'Expiration', 'Data correction']
    for i in range(1, 101):
        adj_num = f"ADJ{i:05d}"
        wh_id = random.randint(1, 5)
        adj_date = random_date(2023, 2024)
        reason = random.choice(reasons)
        adjusted_by = random.choice(employee_ids)
        sql_parts.append(f"INSERT INTO inventory_adjustments (adjustment_id, adjustment_number, warehouse_id, adjustment_date, reason, adjusted_by) VALUES ({i}, {escape_sql(adj_num)}, {wh_id}, {escape_sql(adj_date)}, {escape_sql(reason)}, {adjusted_by});")
    sql_parts.append("")

    # Adjustment Lines (300)
    sql_parts.append("-- Adjustment Lines")
    for i in range(1, 301):
        adj_id = random.randint(1, 100)
        prod_id = random.choice(product_ids)
        qty_before = random.randint(0, 500)
        qty_change = random.randint(-20, 20)
        qty_after = max(0, qty_before + qty_change)
        sql_parts.append(f"INSERT INTO adjustment_lines (line_id, adjustment_id, product_id, quantity_before, quantity_after) VALUES ({i}, {adj_id}, {prod_id}, {qty_before}, {qty_after});")
    sql_parts.append("")

    # Reorder Rules (500)
    sql_parts.append("-- Reorder Rules")
    reorder_seen = set()
    rule_id = 1
    for i in range(1, 501):
        prod_id = random.choice(product_ids)
        wh_id = random.randint(1, 5)
        key = (prod_id, wh_id)
        if key in reorder_seen:
            continue
        reorder_seen.add(key)
        min_qty = random.randint(10, 50)
        reorder_qty = random.randint(50, 200)
        sql_parts.append(f"INSERT INTO reorder_rules (rule_id, product_id, warehouse_id, min_quantity, reorder_quantity) VALUES ({rule_id}, {prod_id}, {wh_id}, {min_qty}, {reorder_qty});")
        rule_id += 1
    sql_parts.append("")

    # ========== SALES MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- SALES MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Customers (1000)
    sql_parts.append("-- Customers")
    for i in range(1, 1001):
        cust_num = f"CUST{i:05d}"
        name = f"{random.choice(COMPANY_PREFIXES)} {random.choice(COMPANY_SUFFIXES)}"
        email = f"info@{name.lower().replace(' ', '')}.com"
        phone = gen_phone()
        billing_addr = random.choice(address_ids[600:1200])
        shipping_addr = random.choice(address_ids[600:1200])
        credit_limit = random.choice([10000, 25000, 50000, 100000, 250000])
        payment_terms = random.choice([15, 30, 45, 60])
        curr = random.randint(1, 5)
        sql_parts.append(f"INSERT INTO customers (customer_id, customer_number, name, email, phone, billing_address_id, shipping_address_id, credit_limit, payment_terms, currency_id) VALUES ({i}, {escape_sql(cust_num)}, {escape_sql(name)}, {escape_sql(email)}, {escape_sql(phone)}, {billing_addr}, {shipping_addr}, {credit_limit}, {payment_terms}, {curr});")
        customer_ids.append(i)
    sql_parts.append("")

    # Customer Contacts (2000)
    sql_parts.append("-- Customer Contacts")
    titles = ["Purchasing Manager", "Buyer", "Accounts Payable", "Operations Manager", "CEO", "CFO"]
    for i in range(1, 2001):
        cust_id = random.choice(customer_ids)
        first = random.choice(FIRST_NAMES)
        last = random.choice(LAST_NAMES)
        email = f"{first.lower()}.{last.lower()}@example.com"
        phone = gen_phone()
        title = random.choice(titles)
        is_primary = "TRUE" if i % 5 == 0 else "FALSE"
        sql_parts.append(f"INSERT INTO customer_contacts (contact_id, customer_id, first_name, last_name, email, phone, title, is_primary) VALUES ({i}, {cust_id}, {escape_sql(first)}, {escape_sql(last)}, {escape_sql(email)}, {escape_sql(phone)}, {escape_sql(title)}, {is_primary});")
    sql_parts.append("")

    # Sales Regions
    sql_parts.append("-- Sales Regions")
    regions = [("Northeast", 100000000), ("Southeast", 80000000), ("Midwest", 70000000), ("Southwest", 60000000), ("West", 90000000)]
    for i, (name, target) in enumerate(regions, 1):
        mgr = random.randint(1, 50)
        sql_parts.append(f"INSERT INTO sales_regions (region_id, name, manager_id, target_revenue) VALUES ({i}, {escape_sql(name)}, {mgr}, {target});")
    sql_parts.append("")

    # Sales Territories (20)
    sql_parts.append("-- Sales Territories")
    territory_names = [
        "NY Metro", "Boston", "Philadelphia", "DC Metro", "Atlanta", "Miami", "Chicago",
        "Detroit", "Minneapolis", "Dallas", "Houston", "Phoenix", "Denver", "LA Metro",
        "San Francisco", "Seattle", "Portland", "San Diego", "Las Vegas", "Salt Lake"
    ]
    for i, name in enumerate(territory_names, 1):
        region = ((i - 1) // 4) + 1
        rep = random.randint(1, 100)
        sql_parts.append(f"INSERT INTO sales_territories (territory_id, name, region_id, assigned_rep_id) VALUES ({i}, {escape_sql(name)}, {region}, {rep});")
    sql_parts.append("")

    # Opportunity Stages
    sql_parts.append("-- Opportunity Stages")
    for i, (name, seq, prob, is_closed, is_won) in enumerate(OPPORTUNITY_STAGES, 1):
        sql_parts.append(f"INSERT INTO opportunity_stages (stage_id, name, sequence, probability, is_closed, is_won) VALUES ({i}, {escape_sql(name)}, {seq}, {prob}, {str(is_closed).upper()}, {str(is_won).upper()});")
    sql_parts.append("")

    # Sales Opportunities (500)
    sql_parts.append("-- Sales Opportunities")
    sources = ["Website", "Referral", "Trade Show", "Cold Call", "Advertising", "Partner"]
    for i in range(1, 501):
        name = f"Opportunity - {random.choice(COMPANY_PREFIXES)} Deal {i}"
        cust_id = random.choice(customer_ids)
        owner = random.randint(1, 100)
        stage = random.randint(1, 6)
        amount = decimal_val(5000, 500000)
        prob = OPPORTUNITY_STAGES[stage-1][2]
        expected_close = random_date(2024, 2025)
        actual_close = expected_close if stage >= 5 else None
        source = random.choice(sources)
        sql_parts.append(f"INSERT INTO sales_opportunities (opportunity_id, name, customer_id, owner_id, stage_id, amount, probability, expected_close_date, actual_close_date, source) VALUES ({i}, {sql_val(name)}, {cust_id}, {owner}, {stage}, {amount}, {prob}, {sql_val(expected_close)}, {sql_val(actual_close)}, {sql_val(source)});")
    sql_parts.append("")

    # Sales Quotes (1500)
    sql_parts.append("-- Sales Quotes")
    for i in range(1, 1501):
        quote_num = f"QT{i:06d}"
        cust_id = random.choice(customer_ids)
        opp_id = random.randint(1, 500) if random.random() > 0.3 else "NULL"
        quote_date = random_date(2023, 2024)
        valid_until = (datetime.strptime(quote_date, '%Y-%m-%d') + timedelta(days=30)).strftime('%Y-%m-%d')
        subtotal = decimal_val(1000, 100000)
        tax = round(subtotal * 0.08, 2)
        total = round(subtotal + tax, 2)
        status = random.choice(['draft', 'sent', 'accepted', 'rejected', 'expired'])
        created_by = random.randint(1, 100)
        sql_parts.append(f"INSERT INTO sales_quotes (quote_id, quote_number, customer_id, opportunity_id, quote_date, valid_until, subtotal, tax_amount, total, status, created_by) VALUES ({i}, {escape_sql(quote_num)}, {cust_id}, {opp_id}, {escape_sql(quote_date)}, {escape_sql(valid_until)}, {subtotal}, {tax}, {total}, {escape_sql(status)}, {created_by});")
    sql_parts.append("")

    # Quote Lines (4000)
    sql_parts.append("-- Quote Lines")
    for i in range(1, 4001):
        quote_id = random.randint(1, 1500)
        prod_id = random.choice(product_ids)
        qty = random.randint(1, 50)
        unit_price = decimal_val(10, 500)
        discount = random.choice([0, 0, 0, 5, 10, 15])
        sql_parts.append(f"INSERT INTO quote_lines (line_id, quote_id, product_id, quantity, unit_price, discount_percent) VALUES ({i}, {quote_id}, {prod_id}, {qty}, {unit_price}, {discount});")
    sql_parts.append("")

    # Sales Orders (5000)
    sql_parts.append("-- Sales Orders")
    for i in range(1, 5001):
        order_num = f"SO{i:06d}"
        cust_id = random.choice(customer_ids)
        quote_id = random.randint(1, 1500) if random.random() > 0.4 else "NULL"
        order_date = random_date(2022, 2024)
        required_date = (datetime.strptime(order_date, '%Y-%m-%d') + timedelta(days=random.randint(7, 30))).strftime('%Y-%m-%d')
        ship_date_obj = datetime.strptime(order_date, '%Y-%m-%d') + timedelta(days=random.randint(3, 14))
        ship_date = ship_date_obj.strftime('%Y-%m-%d') if random.random() > 0.2 else None
        subtotal = decimal_val(500, 50000)
        tax = round(subtotal * 0.08, 2)
        shipping = decimal_val(20, 200)
        total = round(subtotal + tax + shipping, 2)
        status = random.choice(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'])
        ship_addr = random.choice(address_ids[600:1200])
        rep = random.randint(1, 100)
        sql_parts.append(f"INSERT INTO sales_orders (order_id, order_number, customer_id, quote_id, order_date, required_date, ship_date, subtotal, tax_amount, shipping_cost, total, status, shipping_address_id, sales_rep_id) VALUES ({i}, {sql_val(order_num)}, {cust_id}, {quote_id}, {sql_val(order_date)}, {sql_val(required_date)}, {sql_val(ship_date)}, {subtotal}, {tax}, {shipping}, {total}, {sql_val(status)}, {ship_addr}, {rep});")
    sql_parts.append("")

    # Order Lines (15000)
    sql_parts.append("-- Order Lines")
    for i in range(1, 15001):
        order_id = random.randint(1, 5000)
        prod_id = random.choice(product_ids)
        qty = random.randint(1, 100)
        unit_price = decimal_val(10, 500)
        discount = random.choice([0, 0, 0, 5, 10, 15])
        sql_parts.append(f"INSERT INTO order_lines (line_id, order_id, product_id, quantity, unit_price, discount_percent) VALUES ({i}, {order_id}, {prod_id}, {qty}, {unit_price}, {discount});")
    sql_parts.append("")

    # ========== PROCUREMENT MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- PROCUREMENT MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Vendors (200)
    sql_parts.append("-- Vendors")
    for i in range(1, 201):
        vendor_num = f"VND{i:05d}"
        name = f"{random.choice(COMPANY_PREFIXES)} {random.choice(['Supply', 'Distributors', 'Manufacturing', 'Trading', 'Wholesale'])}"
        email = f"sales@{name.lower().replace(' ', '')}.com"
        phone = gen_phone()
        payment_terms = random.choice([15, 30, 45, 60])
        addr = random.choice(address_ids[1200:1600])
        sql_parts.append(f"INSERT INTO vendors (vendor_id, vendor_number, name, email, phone, payment_terms, address_id) VALUES ({i}, {escape_sql(vendor_num)}, {escape_sql(name)}, {escape_sql(email)}, {escape_sql(phone)}, {payment_terms}, {addr});")
        vendor_ids.append(i)
    sql_parts.append("")

    # Vendor Contacts (400)
    sql_parts.append("-- Vendor Contacts")
    vendor_titles = ["Sales Rep", "Account Manager", "Customer Service", "Shipping Coordinator"]
    for i in range(1, 401):
        vendor_id = random.choice(vendor_ids)
        first = random.choice(FIRST_NAMES)
        last = random.choice(LAST_NAMES)
        email = f"{first.lower()}.{last.lower()}@vendor.com"
        phone = gen_phone()
        title = random.choice(vendor_titles)
        is_primary = "TRUE" if i % 4 == 0 else "FALSE"
        sql_parts.append(f"INSERT INTO vendor_contacts (contact_id, vendor_id, first_name, last_name, email, phone, title, is_primary) VALUES ({i}, {vendor_id}, {escape_sql(first)}, {escape_sql(last)}, {escape_sql(email)}, {escape_sql(phone)}, {escape_sql(title)}, {is_primary});")
    sql_parts.append("")

    # Purchase Requisitions (500)
    sql_parts.append("-- Purchase Requisitions")
    for i in range(1, 501):
        req_num = f"REQ{i:06d}"
        requested_by = random.choice(employee_ids)
        request_date = random_date(2023, 2024)
        status = random.choice(['draft', 'submitted', 'approved', 'rejected', 'converted'])
        approved_by = random.randint(1, 50) if status in ['approved', 'converted'] else "NULL"
        sql_parts.append(f"INSERT INTO purchase_requisitions (requisition_id, requisition_number, requested_by, request_date, status, approved_by) VALUES ({i}, {escape_sql(req_num)}, {requested_by}, {escape_sql(request_date)}, {escape_sql(status)}, {approved_by});")
    sql_parts.append("")

    # Requisition Lines (1500)
    sql_parts.append("-- Requisition Lines")
    for i in range(1, 1501):
        req_id = random.randint(1, 500)
        prod_id = random.choice(product_ids)
        qty = random.randint(5, 100)
        est_cost = decimal_val(50, 5000)
        sql_parts.append(f"INSERT INTO requisition_lines (line_id, requisition_id, product_id, quantity, estimated_unit_cost) VALUES ({i}, {req_id}, {prod_id}, {qty}, {est_cost});")
    sql_parts.append("")

    # Purchase Orders (2000)
    sql_parts.append("-- Purchase Orders")
    for i in range(1, 2001):
        po_num = f"PO{i:06d}"
        vendor_id = random.choice(vendor_ids)
        order_date = random_date(2022, 2024)
        expected_date = (datetime.strptime(order_date, '%Y-%m-%d') + timedelta(days=random.randint(7, 30))).strftime('%Y-%m-%d')
        subtotal = decimal_val(500, 50000)
        tax = round(subtotal * 0.08, 2)
        total = round(subtotal + tax, 2)
        status = random.choice(['draft', 'sent', 'confirmed', 'received', 'cancelled'])
        buyer_id = random.choice(employee_ids[:100])
        sql_parts.append(f"INSERT INTO purchase_orders (po_id, po_number, vendor_id, order_date, expected_date, subtotal, tax_amount, total, status, buyer_id) VALUES ({i}, {sql_val(po_num)}, {vendor_id}, {sql_val(order_date)}, {sql_val(expected_date)}, {subtotal}, {tax}, {total}, {sql_val(status)}, {buyer_id});")
    sql_parts.append("")

    # PO Lines (6000)
    sql_parts.append("-- PO Lines")
    for i in range(1, 6001):
        po_id = random.randint(1, 2000)
        prod_id = random.choice(product_ids)
        qty = random.randint(5, 200)
        unit_cost = decimal_val(5, 300)
        sql_parts.append(f"INSERT INTO po_lines (line_id, po_id, product_id, quantity, unit_cost) VALUES ({i}, {po_id}, {prod_id}, {qty}, {unit_cost});")
    sql_parts.append("")

    # Goods Receipts (1500)
    sql_parts.append("-- Goods Receipts")
    for i in range(1, 1501):
        receipt_num = f"GR{i:06d}"
        po_id = random.randint(1, 2000)
        receipt_date = random_date(2022, 2024)
        received_by = random.choice(employee_ids)
        wh_id = random.randint(1, 5)
        sql_parts.append(f"INSERT INTO goods_receipts (receipt_id, receipt_number, po_id, receipt_date, warehouse_id, received_by) VALUES ({i}, {escape_sql(receipt_num)}, {po_id}, {escape_sql(receipt_date)}, {wh_id}, {received_by});")
    sql_parts.append("")

    # Receipt Lines (4000)
    sql_parts.append("-- Receipt Lines")
    for i in range(1, 4001):
        receipt_id = random.randint(1, 1500)
        prod_id = random.choice(product_ids)
        qty_received = random.randint(1, 100)
        loc_id = random.randint(1, 100)
        sql_parts.append(f"INSERT INTO receipt_lines (line_id, receipt_id, product_id, quantity_received, location_id) VALUES ({i}, {receipt_id}, {prod_id}, {qty_received}, {loc_id});")
    sql_parts.append("")

    # Vendor Invoices (1800)
    sql_parts.append("-- Vendor Invoices")
    for i in range(1, 1801):
        invoice_num = f"VI{i:06d}"
        vendor_id = random.choice(vendor_ids)
        po_id = random.randint(1, 2000) if random.random() > 0.1 else "NULL"
        invoice_date = random_date(2022, 2024)
        due_date = (datetime.strptime(invoice_date, '%Y-%m-%d') + timedelta(days=30)).strftime('%Y-%m-%d')
        subtotal = decimal_val(500, 50000)
        tax = round(subtotal * 0.08, 2)
        total = round(subtotal + tax, 2)
        status = random.choice(['pending', 'approved', 'paid', 'disputed'])
        sql_parts.append(f"INSERT INTO vendor_invoices (invoice_id, invoice_number, vendor_id, po_id, invoice_date, due_date, subtotal, tax_amount, total, status) VALUES ({i}, {escape_sql(invoice_num)}, {vendor_id}, {po_id}, {escape_sql(invoice_date)}, {escape_sql(due_date)}, {subtotal}, {tax}, {total}, {escape_sql(status)});")
    sql_parts.append("")

    # Vendor Invoice Lines (5000)
    sql_parts.append("-- Vendor Invoice Lines")
    for i in range(1, 5001):
        invoice_id = random.randint(1, 1800)
        desc = random.choice(["Product purchase", "Shipping charges", "Service fee", "Materials", "Equipment"])
        amount = decimal_val(50, 5000)
        acct_id = random.randint(1, len(accounts))
        sql_parts.append(f"INSERT INTO vendor_invoice_lines (line_id, invoice_id, description, amount, account_id) VALUES ({i}, {invoice_id}, {escape_sql(desc)}, {amount}, {acct_id});")
    sql_parts.append("")

    # ========== PROJECT MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- PROJECT MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Projects (100)
    sql_parts.append("-- Projects")
    project_names = [
        "System Upgrade", "Office Relocation", "Product Launch", "Website Redesign",
        "ERP Implementation", "Marketing Campaign", "Warehouse Expansion", "Training Initiative",
        "Cost Reduction", "Quality Improvement", "Process Automation", "Customer Portal"
    ]
    for i in range(1, 101):
        proj_num = f"PRJ{i:05d}"
        name = f"{random.choice(project_names)} - Phase {(i % 5) + 1}"
        desc = f"Project {i} for strategic business initiative"
        cust_id = random.choice(customer_ids) if random.random() > 0.3 else "NULL"
        start_date = random_date(2022, 2024)
        planned_end = (datetime.strptime(start_date, '%Y-%m-%d') + timedelta(days=random.randint(60, 365))).strftime('%Y-%m-%d')
        status = random.choice(['planning', 'active', 'on_hold', 'completed', 'cancelled'])
        budget = decimal_val(50000, 500000)
        manager = random.randint(1, 50)
        priority = random.choice(['low', 'medium', 'high'])
        sql_parts.append(f"INSERT INTO projects (project_id, project_number, name, description, customer_id, start_date, planned_end_date, status, budget, project_manager_id, priority) VALUES ({i}, {sql_val(proj_num)}, {sql_val(name)}, {sql_val(desc)}, {cust_id}, {sql_val(start_date)}, {sql_val(planned_end)}, {sql_val(status)}, {budget}, {manager}, {sql_val(priority)});")
    sql_parts.append("")

    # Project Phases (300)
    sql_parts.append("-- Project Phases")
    phase_names = ["Planning", "Design", "Development", "Testing", "Deployment", "Closure"]
    phase_id = 1
    for proj_id in range(1, 101):
        num_phases = random.randint(3, 6)
        for j in range(num_phases):
            name = phase_names[j % len(phase_names)]
            start = random_date(2022, 2024)
            end = (datetime.strptime(start, '%Y-%m-%d') + timedelta(days=random.randint(14, 60))).strftime('%Y-%m-%d')
            status = random.choice(['pending', 'active', 'completed'])
            sql_parts.append(f"INSERT INTO project_phases (phase_id, project_id, name, sequence, start_date, end_date, status) VALUES ({phase_id}, {proj_id}, {escape_sql(name)}, {j + 1}, {escape_sql(start)}, {escape_sql(end)}, {escape_sql(status)});")
            phase_id += 1
    sql_parts.append("")

    # Project Tasks (1000)
    sql_parts.append("-- Project Tasks")
    task_names = [
        "Requirements gathering", "Design review", "Development sprint", "Code review",
        "Unit testing", "Integration testing", "Documentation", "Training", "Deployment",
        "User acceptance testing", "Bug fixes", "Performance optimization"
    ]
    for i in range(1, 1001):
        phase_id = random.randint(1, 300)
        name = random.choice(task_names)
        desc = f"Task: {name}"
        est_hours = random.randint(4, 80)
        status = random.choice(['pending', 'in_progress', 'completed', 'blocked'])
        priority = random.choice(['low', 'medium', 'high', 'critical'])
        sql_parts.append(f"INSERT INTO project_tasks (task_id, phase_id, name, description, estimated_hours, status, priority) VALUES ({i}, {phase_id}, {escape_sql(name)}, {escape_sql(desc)}, {est_hours}, {escape_sql(status)}, {escape_sql(priority)});")
    sql_parts.append("")

    # Task Assignments (1500)
    sql_parts.append("-- Task Assignments")
    roles = ["Lead", "Developer", "Tester", "Analyst", "Reviewer"]
    for i in range(1, 1501):
        task_id = random.randint(1, 1000)
        emp_id = random.choice(employee_ids)
        assigned_date = random_date(2022, 2024)
        role = random.choice(roles)
        sql_parts.append(f"INSERT INTO task_assignments (assignment_id, task_id, employee_id, assigned_date, role) VALUES ({i}, {task_id}, {emp_id}, {escape_sql(assigned_date)}, {escape_sql(role)});")
    sql_parts.append("")

    # Project Milestones (200)
    sql_parts.append("-- Project Milestones")
    milestone_names = ["Kickoff", "Design Complete", "Alpha Release", "Beta Release", "Go Live", "Project Closure"]
    for i in range(1, 201):
        proj_id = random.randint(1, 100)
        name = random.choice(milestone_names)
        due_date = random_date(2022, 2025)
        completed_date = due_date if random.random() > 0.3 else None
        sql_parts.append(f"INSERT INTO project_milestones (milestone_id, project_id, name, due_date, completed_date) VALUES ({i}, {proj_id}, {sql_val(name)}, {sql_val(due_date)}, {sql_val(completed_date)});")
    sql_parts.append("")

    # Project Budgets (200)
    sql_parts.append("-- Project Budgets")
    budget_categories = ["Labor", "Materials", "Equipment", "Travel", "Consulting", "Contingency"]
    for i in range(1, 201):
        proj_id = random.randint(1, 100)
        category = random.choice(budget_categories)
        planned = decimal_val(10000, 100000)
        actual = round(planned * random.uniform(0.7, 1.3), 2)
        sql_parts.append(f"INSERT INTO project_budgets (budget_id, project_id, category, planned_amount, actual_amount) VALUES ({i}, {proj_id}, {escape_sql(category)}, {planned}, {actual});")
    sql_parts.append("")

    # Project Expenses (500)
    sql_parts.append("-- Project Expenses")
    expense_categories = ["Travel", "Meals", "Supplies", "Equipment", "Software", "Training"]
    for i in range(1, 501):
        proj_id = random.randint(1, 100)
        emp_id = random.choice(employee_ids)
        expense_date = random_date(2022, 2024)
        amount = decimal_val(50, 5000)
        category = random.choice(expense_categories)
        desc = f"{category} expense for project"
        sql_parts.append(f"INSERT INTO project_expenses (expense_id, project_id, employee_id, expense_date, amount, category, description) VALUES ({i}, {proj_id}, {emp_id}, {escape_sql(expense_date)}, {amount}, {escape_sql(category)}, {escape_sql(desc)});")
    sql_parts.append("")

    # Timesheets (2000)
    sql_parts.append("-- Timesheets")
    for i in range(1, 2001):
        emp_id = random.choice(employee_ids)
        # Week start (Monday)
        year = random.randint(2022, 2024)
        week = random.randint(1, 52)
        week_start = datetime(year, 1, 1) + timedelta(weeks=week-1, days=-datetime(year, 1, 1).weekday())
        week_start_str = week_start.strftime('%Y-%m-%d')
        status = random.choice(['draft', 'submitted', 'approved', 'rejected'])
        approved_by = random.randint(1, 50) if status == 'approved' else "NULL"
        sql_parts.append(f"INSERT INTO timesheets (timesheet_id, employee_id, week_start_date, status, approved_by) VALUES ({i}, {emp_id}, {escape_sql(week_start_str)}, {escape_sql(status)}, {approved_by});")
    sql_parts.append("")

    # Timesheet Entries (8000)
    sql_parts.append("-- Timesheet Entries")
    for i in range(1, 8001):
        ts_id = random.randint(1, 2000)
        proj_id = random.randint(1, 100)
        task_id = random.randint(1, 1000)
        entry_date = random_date(2022, 2024)
        hours = decimal_val(1, 8, 1)
        desc = random.choice(["Development work", "Testing", "Meetings", "Documentation", "Code review", "Planning"])
        sql_parts.append(f"INSERT INTO timesheet_entries (entry_id, timesheet_id, project_id, task_id, entry_date, hours, description) VALUES ({i}, {ts_id}, {proj_id}, {task_id}, {escape_sql(entry_date)}, {hours}, {escape_sql(desc)});")
    sql_parts.append("")

    # Project Resources (300)
    sql_parts.append("-- Project Resources")
    for i in range(1, 301):
        proj_id = random.randint(1, 100)
        emp_id = random.choice(employee_ids)
        allocation = random.choice([25, 50, 75, 100])
        start = random_date(2022, 2024)
        end = (datetime.strptime(start, '%Y-%m-%d') + timedelta(days=random.randint(30, 180))).strftime('%Y-%m-%d')
        sql_parts.append(f"INSERT INTO project_resources (resource_id, project_id, employee_id, allocation_percent, start_date, end_date) VALUES ({i}, {proj_id}, {emp_id}, {allocation}, {escape_sql(start)}, {escape_sql(end)});")
    sql_parts.append("")

    # ========== ASSETS MODULE ==========
    sql_parts.append("-- ============================================")
    sql_parts.append("-- ASSETS MODULE")
    sql_parts.append("-- ============================================")
    sql_parts.append("")

    # Asset Categories
    sql_parts.append("-- Asset Categories")
    for i, (name, method, years) in enumerate(ASSET_CATEGORIES, 1):
        sql_parts.append(f"INSERT INTO asset_categories (category_id, name, depreciation_method, useful_life_years) VALUES ({i}, {escape_sql(name)}, {escape_sql(method)}, {years});")
    sql_parts.append("")

    # Asset Locations
    sql_parts.append("-- Asset Locations")
    buildings = ["HQ", "Warehouse A", "Warehouse B", "Factory", "Sales Office"]
    loc_id = 1
    for building in buildings:
        for floor in range(1, 4):
            for room in range(1, 6):
                name = f"{building} - Floor {floor} Room {room}"
                sql_parts.append(f"INSERT INTO asset_locations (location_id, name, building, floor, room) VALUES ({loc_id}, {escape_sql(name)}, {escape_sql(building)}, {floor}, {escape_sql(str(room))});")
                loc_id += 1
    sql_parts.append("")

    # Fixed Assets (500)
    sql_parts.append("-- Fixed Assets")
    asset_names = [
        "Dell Laptop", "HP Desktop", "Dell Monitor", "Cisco Router", "Office Desk",
        "Executive Chair", "File Cabinet", "Ford Van", "Toyota Forklift", "CNC Machine",
        "Assembly Robot", "Server Rack", "UPS System", "Air Conditioner", "Conference Table"
    ]
    for i in range(1, 501):
        name = f"{random.choice(asset_names)} #{i}"
        asset_tag = f"AST{i:05d}"
        category = random.randint(1, len(ASSET_CATEGORIES))
        purchase_date = random_date(2018, 2024)
        purchase_cost = decimal_val(500, 50000)
        loc_id = random.randint(1, 75)
        serial_num = f"SN{random.randint(100000, 999999)}"
        status = random.choice(['active', 'active', 'active', 'disposed', 'maintenance'])
        sql_parts.append(f"INSERT INTO fixed_assets (asset_id, name, asset_tag, category_id, purchase_date, purchase_cost, location_id, serial_number, status) VALUES ({i}, {escape_sql(name)}, {escape_sql(asset_tag)}, {category}, {escape_sql(purchase_date)}, {purchase_cost}, {loc_id}, {escape_sql(serial_num)}, {escape_sql(status)});")
    sql_parts.append("")

    # Depreciation Schedules (500)
    sql_parts.append("-- Depreciation Schedules")
    for i in range(1, 501):
        asset_id = i
        method = random.choice(['straight-line', 'declining-balance'])
        start = random_date(2018, 2024)
        years = random.randint(3, 10)
        useful_life_months = years * 12
        end = (datetime.strptime(start, '%Y-%m-%d') + timedelta(days=years*365)).strftime('%Y-%m-%d')
        annual = decimal_val(100, 10000)
        monthly = round(annual / 12, 2)
        sql_parts.append(f"INSERT INTO depreciation_schedules (schedule_id, asset_id, depreciation_method, useful_life_months, start_date, end_date, monthly_amount, annual_amount) VALUES ({i}, {asset_id}, {escape_sql(method)}, {useful_life_months}, {escape_sql(start)}, {escape_sql(end)}, {monthly}, {annual});")
    sql_parts.append("")

    # Depreciation Entries (2000)
    sql_parts.append("-- Depreciation Entries")
    for i in range(1, 2001):
        asset_id = random.randint(1, 500)
        period_id = random.randint(1, 48)
        entry_date = random_date(2022, 2024)
        amount = decimal_val(50, 1000)
        accum = decimal_val(100, 20000)
        book_value = max(0, decimal_val(1000, 50000) - accum)
        sql_parts.append(f"INSERT INTO depreciation_entries (entry_id, asset_id, period_id, entry_date, amount, accumulated_depreciation, book_value) VALUES ({i}, {asset_id}, {period_id}, {escape_sql(entry_date)}, {amount}, {accum}, {book_value});")
    sql_parts.append("")

    # Maintenance Types
    sql_parts.append("-- Maintenance Types")
    for i, (name, desc, freq) in enumerate(MAINTENANCE_TYPES, 1):
        freq_val = freq if freq else "NULL"
        sql_parts.append(f"INSERT INTO maintenance_types (type_id, name, description, frequency_months) VALUES ({i}, {escape_sql(name)}, {escape_sql(desc)}, {freq_val});")
    sql_parts.append("")

    # Asset Maintenance (300)
    sql_parts.append("-- Asset Maintenance")
    for i in range(1, 301):
        asset_id = random.randint(1, 500)
        maint_type = random.randint(1, len(MAINTENANCE_TYPES))
        scheduled = random_date(2022, 2025)
        completed = scheduled if random.random() > 0.3 else None
        cost = decimal_val(50, 2000)
        sql_parts.append(f"INSERT INTO asset_maintenance (maintenance_id, asset_id, maintenance_type_id, scheduled_date, completed_date, cost) VALUES ({i}, {asset_id}, {maint_type}, {sql_val(scheduled)}, {sql_val(completed)}, {cost});")
    sql_parts.append("")

    # Asset Transfers (100)
    sql_parts.append("-- Asset Transfers")
    for i in range(1, 101):
        asset_id = random.randint(1, 500)
        from_loc = random.randint(1, 75)
        to_loc = random.choice([l for l in range(1, 76) if l != from_loc])
        transfer_date = random_date(2022, 2024)
        transferred_by = random.choice(employee_ids)
        reason = random.choice(["Relocation", "Reorganization", "Maintenance", "User request"])
        sql_parts.append(f"INSERT INTO asset_transfers (transfer_id, asset_id, from_location_id, to_location_id, transfer_date, transferred_by, reason) VALUES ({i}, {asset_id}, {from_loc}, {to_loc}, {escape_sql(transfer_date)}, {transferred_by}, {escape_sql(reason)});")
    sql_parts.append("")

    # Document Attachments (500)
    sql_parts.append("-- Document Attachments")
    entity_types = ['employee', 'customer', 'vendor', 'project', 'asset', 'purchase_order', 'sales_order']
    file_types = ['.pdf', '.docx', '.xlsx', '.jpg', '.png']
    for i in range(1, 501):
        entity_type = random.choice(entity_types)
        entity_id = random.randint(1, 100)
        file_name = f"document_{i}{random.choice(file_types)}"
        file_path = f"/documents/{entity_type}/{entity_id}/{file_name}"
        uploaded_by = random.choice(employee_ids)
        sql_parts.append(f"INSERT INTO document_attachments (attachment_id, entity_type, entity_id, file_name, file_path, uploaded_by) VALUES ({i}, {escape_sql(entity_type)}, {entity_id}, {escape_sql(file_name)}, {escape_sql(file_path)}, {uploaded_by});")
    sql_parts.append("")

    sql_parts.append("")
    sql_parts.append("")
    sql_parts.append("-- Data generation complete")
    sql_parts.append(f"-- Total INSERT statements: ~85,000")

    return batch_inserts("\n".join(sql_parts))


if __name__ == "__main__":
    print("Generating Enterprise ERP sample data...")
    sql = generate_sql()

    output_file = "/home/noahc/nl2sql-project/enterprise-erp/002_sample_data.sql"
    with open(output_file, 'w') as f:
        f.write(sql)

    print(f"Sample data written to {output_file}")
    print(f"File size: {len(sql):,} characters")
