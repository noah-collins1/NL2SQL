# Deterministic seeds and division sizing
DIVISION_COUNT = 20
BASE_SEED = 20240213

# Division size multipliers (realistic skew)
DIVISION_SIZE = {
    f"div_{i:02d}": (0.6 + (i % 5) * 0.25) for i in range(1, DIVISION_COUNT + 1)
}

# Archetype mapping: division → archetype
# Manufacturing: div_01–05, Services: div_06–10, Retail: div_11–15, Corporate: div_16–20
ARCHETYPE_FOR_DIVISION = {}
for _i in range(1, DIVISION_COUNT + 1):
    _schema = f"div_{_i:02d}"
    if _i <= 5:
        ARCHETYPE_FOR_DIVISION[_schema] = "manufacturing"
    elif _i <= 10:
        ARCHETYPE_FOR_DIVISION[_schema] = "services"
    elif _i <= 15:
        ARCHETYPE_FOR_DIVISION[_schema] = "retail"
    else:
        ARCHETYPE_FOR_DIVISION[_schema] = "corporate"

# Divisions that use abbreviated/dirty column naming (~30%)
DIRTY_NAMING_DIVISIONS = {
    "div_02", "div_04",   # manufacturing
    "div_07", "div_09",   # services
    "div_12", "div_14",   # retail
}
