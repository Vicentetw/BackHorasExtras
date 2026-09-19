# file: enrolar_interactivo.py

import tkinter as tk
from tkinter import ttk, messagebox
import threading
import pythoncom
import win32com.client

class ZKEMApp:
    """GUI para enrolar huellas en ZKTeco K20 Pro usando SDK oficial"""

    def __init__(self, root):
        self.root = root
        self.root.title("Enrolamiento ZKTeco K20 Pro")
        self.root.geometry("500x450")

        self.zkem = None
        self.connected = False

        self.build_gui()

    def build_gui(self):
        # Conexión
        frame_conn = ttk.LabelFrame(self.root, text="Conexión")
        frame_conn.pack(fill="x", padx=10, pady=5)

        ttk.Label(frame_conn, text="IP").grid(row=0, column=0, padx=5)
        self.ip_entry = ttk.Entry(frame_conn)
        self.ip_entry.insert(0, "172.155.0.32")
        self.ip_entry.grid(row=0, column=1)

        ttk.Label(frame_conn, text="Puerto").grid(row=1, column=0)
        self.port_entry = ttk.Entry(frame_conn)
        self.port_entry.insert(0, "4370")
        self.port_entry.grid(row=1, column=1)

        ttk.Button(frame_conn, text="Conectar", command=self.connect_device).grid(row=2, column=0, pady=5)
        ttk.Button(frame_conn, text="Desconectar", command=self.disconnect_device).grid(row=2, column=1, pady=5)

        # Enrolamiento
        frame_enroll = ttk.LabelFrame(self.root, text="Enrolar Huella")
        frame_enroll.pack(fill="x", padx=10, pady=10)

        ttk.Label(frame_enroll, text="Badge ID").grid(row=0, column=0)
        self.uid_entry = ttk.Entry(frame_enroll)
        self.uid_entry.grid(row=0, column=1)

        ttk.Label(frame_enroll, text="Dedo (0-9)").grid(row=1, column=0)
        self.index_entry = ttk.Entry(frame_enroll)
        self.index_entry.insert(0, "0")
        self.index_entry.grid(row=1, column=1)

        ttk.Button(frame_enroll, text="Iniciar Enrolamiento", command=self.start_enroll).grid(
            row=2, column=0, columnspan=2, pady=10
        )

        # Log
        frame_log = ttk.LabelFrame(self.root, text="Log")
        frame_log.pack(fill="both", expand=True, padx=10, pady=10)
        self.log = tk.Text(frame_log)
        self.log.pack(fill="both", expand=True)

    def write_log(self, text):
        self.log.insert(tk.END, text + "\n")
        self.log.see(tk.END)

    def connect_device(self):
        try:
            pythoncom.CoInitialize()
            self.zkem = win32com.client.Dispatch('zkemkeeper.ZKEM.1')
            ip = self.ip_entry.get()
            port = int(self.port_entry.get())
            self.write_log(f"Conectando a {ip}:{port}...")
            if self.zkem.Connect_NET(ip, port):
                self.connected = True
                self.write_log("Conectado al dispositivo SDK.")
            else:
                self.write_log("Error: No se pudo conectar al dispositivo.")
        except Exception as e:
            messagebox.showerror("Error conexión", str(e))

    def disconnect_device(self):
        if self.connected:
            self.zkem.Disconnect()
            self.connected = False
            self.write_log("Desconectado del dispositivo.")

    def start_enroll(self):
        if not self.connected:
            messagebox.showwarning("Error", "Conectar primero al reloj.")
            return

        try:
            badge_id = int(self.uid_entry.get())
            finger_index = int(self.index_entry.get())
        except ValueError:
            messagebox.showerror("Error", "Badge ID y Finger Index deben ser números.")
            return

        def enroll_thread():
            try:
                self.write_log(f"Iniciando enrolamiento para Badge {badge_id}, dedo {finger_index}...")
                # Inicia enrolamiento interactivo en el reloj
                self.zkem.StartEnrollEx(badge_id, finger_index, 0)
                self.write_log("El reloj ahora solicita colocar el dedo...")
                self.write_log("Esperando que el usuario coloque el dedo en el sensor.")
            except Exception as e:
                self.write_log("Error enrolamiento: " + str(e))

        threading.Thread(target=enroll_thread).start()


def main():
    root = tk.Tk()
    app = ZKEMApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()