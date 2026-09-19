import csv
from datetime import datetime
from zoneinfo import ZoneInfo


# =====================================
# CONVERTIR SEGÚN ZONA HORARIA
# =====================================
def convertir_fecha(dt, zona="local"):
    if not dt:
        return ""

    if zona == "local":
        return dt.strftime("%Y-%m-%d %H:%M:%S")

    try:
        tz = ZoneInfo(zona)
        dt = dt.replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
    except:
        pass

    return dt.strftime("%Y-%m-%d %H:%M:%S")


# =====================================
# CHECKINOUT.csv
# =====================================
def exportar_checkinout(attendances, zona="local", archivo="CHECKINOUT.csv"):

    with open(archivo, "w", newline="", encoding="utf-8") as f:

        writer = csv.writer(f, delimiter=';', lineterminator="\r\n")
        # Añadimos MACHINE_IP y MACHINE_SN para poder diferenciar relojes
        writer.writerow(["USERID", "CHECKTIME", "MACHINE_IP", "MACHINE_SN"])

        for a in attendances:
            machine_ip = getattr(a, 'machine_ip', '') or ''
            machine_sn = getattr(a, 'machine_sn', '') or ''
            writer.writerow([
                a.user_id,
                convertir_fecha(a.timestamp, zona),
                machine_ip,
                machine_sn
            ])

    return archivo


# =====================================
# USERINFO.csv
# =====================================
def exportar_userinfo(users, archivo="USERINFO.csv"):

    with open(archivo, "w", newline="", encoding="utf-8") as f:

        writer = csv.writer(f, delimiter=';', lineterminator="\r\n")

        writer.writerow([
            "USERID",
            "Badgenumber",
            "Name"
        ])

        for u in users:
            writer.writerow([
                u.user_id,
                u.user_id,
                u.name
            ])

    return archivo