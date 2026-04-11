#!/usr/bin/env python3
"""Build county_map.json mapping local authorities to ceremonial counties."""
import json
import os

# Read all unique LAs from pub data
pubs = json.loads(open("public/data/pubs.json").read())
las = sorted(set(p.get("local_authority") for p in pubs if p.get("local_authority")))

county_map = {}

# === SCOTTISH LAs (3-letter codes) ===
scottish = {
    "ABN": "Aberdeen City",
    "ANG": "Angus",
    "ARG": "Argyll and Bute",
    "AYR": "Ayrshire",
    "BER": "Scottish Borders",
    "BNF": "Banffshire",
    "BUT": "Bute",
    "CLK": "Clackmannanshire",
    "CTH": "Caithness",
    "DMB": "Dunbartonshire",
    "DMF": "Dumfries and Galloway",
    "ELN": "East Lothian",
    "FFE": "Fife",
    "GLA": "Glasgow",
    "INV": "Inverness-shire",
    "KNC": "Kincardineshire",
    "KNR": "Kinross-shire",
    "LAN": "Lanarkshire",
    "MID": "Midlothian",
    "MOR": "Moray",
    "OAZ": "Orkney",
    "PBL": "Peeblesshire",
    "PTH": "Perthshire",
    "REN": "Renfrewshire",
    "ROS": "Ross and Cromarty",
    "ROX": "Roxburghshire",
    "SEL": "Selkirkshire",
    "STG": "Stirlingshire",
    "STH": "Sutherland",
    "WLN": "West Lothian",
}

for code, county in scottish.items():
    county_map[code] = {"county": county, "country": "Scotland"}

# === WELSH LAs ===
welsh = {
    "Blaenau Gwent County Borough Council": "Blaenau Gwent",
    "Bridgend County Borough Council": "Bridgend",
    "Caerphilly County Borough Council": "Caerphilly",
    "Cardiff Council": "Cardiff",
    "Carmarthenshire County Council": "Carmarthenshire",
    "Ceredigion County Council": "Ceredigion",
    "Conwy County Borough Council": "Conwy",
    "Denbighshire County Council": "Denbighshire",
    "Flintshire County Council": "Flintshire",
    "Gwynedd Council": "Gwynedd",
    "Isle of Anglesey County Council": "Anglesey",
    "Merthyr Tydfil County Borough Council": "Merthyr Tydfil",
    "Monmouthshire County Council": "Monmouthshire",
    "Neath Port Talbot County Borough Council": "Neath Port Talbot",
    "Newport City Council": "Newport",
    "Pembrokeshire County Council": "Pembrokeshire",
    "Powys County Council": "Powys",
    "Rhondda Cynon Taf County Borough Council": "Rhondda Cynon Taf",
    "Swansea Council": "Swansea",
    "Torfaen County Borough Council": "Torfaen",
    "Vale of Glamorgan Council": "Glamorgan",
    "Wrexham County Borough Council": "Wrexham",
}

for la, county in welsh.items():
    county_map[la] = {"county": county, "country": "Wales"}

# === LONDON BOROUGHS ===
london_boroughs = [
    "City of London Corporation",
    "City of Westminster",
    "London Borough of Barking and Dagenham",
    "London Borough of Barnet",
    "London Borough of Bexley",
    "London Borough of Brent",
    "London Borough of Bromley",
    "London Borough of Camden",
    "London Borough of Croydon",
    "London Borough of Ealing",
    "London Borough of Enfield",
    "London Borough of Hackney",
    "London Borough of Hammersmith and Fulham",
    "London Borough of Haringey",
    "London Borough of Harrow",
    "London Borough of Havering",
    "London Borough of Hillingdon",
    "London Borough of Hounslow",
    "London Borough of Islington",
    "London Borough of Lambeth",
    "London Borough of Lewisham",
    "London Borough of Merton",
    "London Borough of Newham",
    "London Borough of Redbridge",
    "London Borough of Richmond upon Thames",
    "London Borough of Southwark",
    "London Borough of Sutton",
    "London Borough of Tower Hamlets",
    "London Borough of Waltham Forest",
    "London Borough of Wandsworth",
    "Royal Borough of Greenwich",
    "Royal Borough of Kensington and Chelsea",
    "Royal Borough of Kingston upon Thames",
]

for la in london_boroughs:
    county_map[la] = {"county": "London", "country": "England"}

# === METROPOLITAN BOROUGHS ===
# Greater Manchester
greater_manchester = [
    "Bolton Metropolitan Borough Council",
    "Bury Metropolitan Borough Council",
    "Manchester City Council",
    "Oldham Metropolitan Borough Council",
    "Rochdale Metropolitan Borough Council",
    "Salford City Council",
    "Stockport Metropolitan Borough Council",
    "Tameside Metropolitan Borough Council",
    "Trafford Borough Council",
    "Wigan Metropolitan Borough Council",
]
for la in greater_manchester:
    county_map[la] = {"county": "Greater Manchester", "country": "England"}

# South Yorkshire
south_yorkshire = [
    "Barnsley Metropolitan Borough Council",
    "Doncaster Metropolitan Borough Council",
    "Rotherham Metropolitan Borough Council",
    "Sheffield City Council",
]
for la in south_yorkshire:
    county_map[la] = {"county": "South Yorkshire", "country": "England"}

# West Yorkshire
west_yorkshire = [
    "Bradford Metropolitan District Council",
    "City of Bradford Metropolitan District Council",
    "Calderdale Metropolitan Borough Council",
    "Kirklees Council",
    "Leeds City Council",
    "Wakefield Metropolitan District Council",
]
for la in west_yorkshire:
    county_map[la] = {"county": "West Yorkshire", "country": "England"}

# Merseyside
merseyside = [
    "Knowsley Metropolitan Borough Council",
    "Liverpool City Council",
    "Sefton Metropolitan Borough Council",
    "St Helens Council",
    "Wirral Borough Council",
]
for la in merseyside:
    county_map[la] = {"county": "Merseyside", "country": "England"}

# Tyne and Wear
tyne_and_wear = [
    "Gateshead Metropolitan Borough Council",
    "Newcastle City Council",
    "North Tyneside Council",
    "South Tyneside Council",
    "Sunderland City Council",
]
for la in tyne_and_wear:
    county_map[la] = {"county": "Tyne and Wear", "country": "England"}

# West Midlands
west_midlands_met = [
    "Birmingham City Council",
    "Coventry City Council",
    "Dudley Metropolitan Borough Council",
    "Sandwell Metropolitan Borough Council",
    "Solihull Metropolitan Borough Council",
    "Walsall Metropolitan Borough Council",
    "City of Wolverhampton Council",
]
for la in west_midlands_met:
    county_map[la] = {"county": "West Midlands", "country": "England"}

# === ENGLISH COUNTY DISTRICTS ===
# Norfolk
norfolk = [
    "Broadland District Council",
    "Breckland District Council",
    "Great Yarmouth Borough Council",
    "Borough Council of Kings Lynn and West Norfolk",
    "North Norfolk District Council",
    "Norwich City Council",
    "South Norfolk Council",
]
for la in norfolk:
    county_map[la] = {"county": "Norfolk", "country": "England"}

# Suffolk
suffolk = [
    "Babergh District Council",
    "East Suffolk Council",
    "Ipswich Borough Council",
    "Mid Suffolk District Council",
    "West Suffolk Council",
]
for la in suffolk:
    county_map[la] = {"county": "Suffolk", "country": "England"}

# Kent
kent = [
    "Ashford Borough Council",
    "Canterbury City Council",
    "Dartford Borough Council",
    "Dover District Council",
    "Folkestone and Hythe District Council",
    "Gravesham Borough Council",
    "Maidstone Borough Council",
    "Medway Council",
    "Sevenoaks District Council",
    "Swale Borough Council",
    "Thanet District Council",
    "Tonbridge and Malling Borough Council",
    "Tunbridge Wells Borough Council",
]
for la in kent:
    county_map[la] = {"county": "Kent", "country": "England"}

# Surrey
surrey = [
    "Elmbridge Borough Council",
    "Epsom and Ewell Borough Council",
    "Guildford Borough Council",
    "Mole Valley District Council",
    "Reigate and Banstead Borough Council",
    "Runnymede Borough Council",
    "Spelthorne Borough Council",
    "Surrey Heath Borough Council",
    "Tandridge District Council",
    "Waverley Borough Council",
    "Woking Borough Council",
]
for la in surrey:
    county_map[la] = {"county": "Surrey", "country": "England"}

# Essex
essex = [
    "Basildon Borough Council",
    "Braintree District Council",
    "Brentwood Borough Council",
    "Castle Point Borough Council",
    "Chelmsford City Council",
    "Colchester Borough Council",
    "Epping Forest District Council",
    "Harlow District Council",
    "Maldon District Council",
    "Rochford District Council",
    "Southend-on-Sea Borough Council",
    "Tendring District Council",
    "Thurrock Council",
    "Uttlesford District Council",
]
for la in essex:
    county_map[la] = {"county": "Essex", "country": "England"}

# Hertfordshire
hertfordshire = [
    "Broxbourne Borough Council",
    "Dacorum Borough Council",
    "East Hertfordshire District Council",
    "Hertsmere Borough Council",
    "North Hertfordshire District Council",
    "St Albans City and District Council",
    "Stevenage Borough Council",
    "Three Rivers District Council",
    "Watford Borough Council",
    "Welwyn Hatfield Borough Council",
]
for la in hertfordshire:
    county_map[la] = {"county": "Hertfordshire", "country": "England"}

# Hampshire
hampshire = [
    "Basingstoke and Deane Borough Council",
    "East Hampshire District Council",
    "Eastleigh Borough Council",
    "Fareham Borough Council",
    "Gosport Borough Council",
    "Hart District Council",
    "Havant Borough Council",
    "New Forest District Council",
    "Rushmoor Borough Council",
    "Southampton City Council",
    "Portsmouth City Council",
    "Test Valley Borough Council",
    "Winchester City Council",
]
for la in hampshire:
    county_map[la] = {"county": "Hampshire", "country": "England"}

# Sussex (East and West)
west_sussex = [
    "Adur District Council",
    "Arun District Council",
    "Chichester District Council",
    "Crawley Borough Council",
    "Horsham District Council",
    "Mid Sussex District Council",
    "Worthing Borough Council",
]
for la in west_sussex:
    county_map[la] = {"county": "West Sussex", "country": "England"}

east_sussex = [
    "Brighton and Hove City Council",
    "Eastbourne Borough Council",
    "Hastings Borough Council",
    "Lewes District Council",
    "Rother District Council",
    "Wealden District Council",
]
for la in east_sussex:
    county_map[la] = {"county": "East Sussex", "country": "England"}

# Devon
devon = [
    "East Devon District Council",
    "Exeter City Council",
    "Mid Devon District Council",
    "North Devon District Council",
    "Plymouth City Council",
    "South Hams District Council",
    "Teignbridge District Council",
    "Torbay Council",
    "Torridge District Council",
    "West Devon Borough Council",
]
for la in devon:
    county_map[la] = {"county": "Devon", "country": "England"}

# Nottinghamshire
nottinghamshire = [
    "Ashfield District Council",
    "Bassetlaw District Council",
    "Broxtowe Borough Council",
    "Gedling Borough Council",
    "Mansfield District Council",
    "Newark and Sherwood District Council",
    "Nottingham City Council",
    "Rushcliffe Borough Council",
]
for la in nottinghamshire:
    county_map[la] = {"county": "Nottinghamshire", "country": "England"}

# Derbyshire
derbyshire = [
    "Amber Valley Borough Council",
    "Bolsover District Council",
    "Chesterfield Borough Council",
    "Derby City Council",
    "Derbyshire Dales District Council",
    "Erewash Borough Council",
    "High Peak Borough Council",
    "North East Derbyshire District Council",
    "South Derbyshire District Council",
]
for la in derbyshire:
    county_map[la] = {"county": "Derbyshire", "country": "England"}

# Leicestershire
leicestershire = [
    "Blaby District Council",
    "Charnwood Borough Council",
    "Harborough District Council",
    "Hinckley and Bosworth Borough Council",
    "Leicester City Council",
    "Melton Borough Council",
    "North West Leicestershire District Council",
    "Oadby and Wigston Borough Council",
]
for la in leicestershire:
    county_map[la] = {"county": "Leicestershire", "country": "England"}

# Staffordshire
staffordshire = [
    "Cannock Chase District Council",
    "East Staffordshire Borough Council",
    "Lichfield District Council",
    "Newcastle-under-Lyme Borough Council",
    "South Staffordshire Council",
    "Stafford Borough Council",
    "Staffordshire Moorlands District Council",
    "Stoke-on-Trent City Council",
    "Tamworth Borough Council",
]
for la in staffordshire:
    county_map[la] = {"county": "Staffordshire", "country": "England"}

# Lincolnshire
lincolnshire = [
    "Boston Borough Council",
    "City of Lincoln Council",
    "East Lindsey District Council",
    "North East Lincolnshire Council",
    "North Kesteven District Council",
    "North Lincolnshire Council",
    "South Holland District Council",
    "South Kesteven District Council",
    "West Lindsey District Council",
]
for la in lincolnshire:
    county_map[la] = {"county": "Lincolnshire", "country": "England"}

# Gloucestershire
gloucestershire = [
    "Cheltenham Borough Council",
    "Cotswold District Council",
    "Forest of Dean District Council",
    "Gloucester City Council",
    "Stroud District Council",
    "Tewkesbury Borough Council",
]
for la in gloucestershire:
    county_map[la] = {"county": "Gloucestershire", "country": "England"}

# Oxfordshire
oxfordshire = [
    "Cherwell District Council",
    "Oxford City Council",
    "South Oxfordshire District Council",
    "Vale of White Horse District Council",
    "West Oxfordshire District Council",
]
for la in oxfordshire:
    county_map[la] = {"county": "Oxfordshire", "country": "England"}

# Cambridgeshire
cambridgeshire = [
    "Cambridge City Council",
    "East Cambridgeshire District Council",
    "Fenland District Council",
    "Huntingdonshire District Council",
    "Peterborough City Council",
    "South Cambridgeshire District Council",
]
for la in cambridgeshire:
    county_map[la] = {"county": "Cambridgeshire", "country": "England"}

# Worcestershire
worcestershire = [
    "Bromsgrove District Council",
    "Malvern Hills District Council",
    "Redditch Borough Council",
    "Worcester City Council",
    "Wychavon District Council",
    "Wyre Forest District Council",
]
for la in worcestershire:
    county_map[la] = {"county": "Worcestershire", "country": "England"}

# Warwickshire
warwickshire = [
    "North Warwickshire Borough Council",
    "Nuneaton and Bedworth Borough Council",
    "Rugby Borough Council",
    "Stratford-on-Avon District Council",
    "Warwick District Council",
]
for la in warwickshire:
    county_map[la] = {"county": "Warwickshire", "country": "England"}

# Lancashire
lancashire = [
    "Blackburn with Darwen Borough Council",
    "Blackpool Borough Council",
    "Burnley Borough Council",
    "Chorley Borough Council",
    "Fylde Borough Council",
    "Hyndburn Borough Council",
    "Lancaster City Council",
    "Pendle Borough Council",
    "Preston City Council",
    "Ribble Valley Borough Council",
    "Rossendale Borough Council",
    "South Ribble Borough Council",
    "West Lancashire Borough Council",
    "Wyre Borough Council",
]
for la in lancashire:
    county_map[la] = {"county": "Lancashire", "country": "England"}

# North Yorkshire
north_yorkshire = [
    "City of York Council",
    "The North Yorkshire Council",
]
for la in north_yorkshire:
    county_map[la] = {"county": "North Yorkshire", "country": "England"}

# === UNITARY AUTHORITIES ===
unitaries = {
    "Bath and North East Somerset Council": "Somerset",
    "Bedford Borough Council": "Bedfordshire",
    "Bournemouth Christchurch and Poole Council": "Dorset",
    "Bracknell Forest Council": "Berkshire",
    "Bristol City Council": "Bristol",
    "Buckinghamshire Council": "Buckinghamshire",
    "Central Bedfordshire Council": "Bedfordshire",
    "Cheshire East Council": "Cheshire",
    "Cheshire West and Chester Council": "Cheshire",
    "Cornwall Council": "Cornwall",
    "Council of the Isles of Scilly": "Cornwall",
    "Cumberland Council": "Cumberland",
    "Darlington Borough Council": "County Durham",
    "Dorset Council": "Dorset",
    "Durham County Council": "County Durham",
    "East Riding of Yorkshire Council": "East Riding of Yorkshire",
    "Halton Borough Council": "Cheshire",
    "Hartlepool Borough Council": "County Durham",
    "Herefordshire Council": "Herefordshire",
    "Hull City Council": "East Riding of Yorkshire",
    "Isle of Wight Council": "Isle of Wight",
    "Luton Borough Council": "Bedfordshire",
    "Middlesbrough Borough Council": "North Yorkshire",
    "Milton Keynes Council": "Buckinghamshire",
    "North Somerset Council": "Somerset",
    "Northumberland County Council": "Northumberland",
    "Reading Borough Council": "Berkshire",
    "Redcar and Cleveland Borough Council": "North Yorkshire",
    "Royal Borough of Windsor and Maidenhead": "Berkshire",
    "Rutland County Council District Council": "Rutland",
    "Shropshire Council": "Shropshire",
    "Slough Borough Council": "Berkshire",
    "Somerset Council": "Somerset",
    "South Gloucestershire Council": "Gloucestershire",
    "Stockton-on-Tees Borough Council": "County Durham",
    "Swindon Borough Council": "Wiltshire",
    "Telford and Wrekin Council": "Shropshire",
    "Warrington Borough Council": "Cheshire",
    "West Berkshire Council": "Berkshire",
    "Westmorland and Furness Council": "Westmorland",
    "Wiltshire Council": "Wiltshire",
    "Wokingham Borough Council": "Berkshire",
    "North Northamptonshire Council": "Northamptonshire",
    "West Northamptonshire Council": "Northamptonshire",
}
for la, county in unitaries.items():
    county_map[la] = {"county": county, "country": "England"}

# === Verify all LAs are mapped ===
missing = [la for la in las if la not in county_map]
if missing:
    print(f"WARNING: {len(missing)} unmapped LAs:")
    for la in missing:
        print(f"  {la}")

# Sort by key and write
county_map = dict(sorted(county_map.items()))
os.makedirs("data", exist_ok=True)
with open("data/county_map.json", "w") as f:
    json.dump(county_map, f, indent=2)

print(f"Wrote {len(county_map)} entries to data/county_map.json")
print(f"Total LAs in data: {len(las)}")
print(f"Mapped: {len(county_map)}")
print(f"Missing: {len(missing)}")
