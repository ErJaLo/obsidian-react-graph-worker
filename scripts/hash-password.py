#!/usr/bin/env python3
"""
Password hashing script using PBKDF2-SHA256.
Generates password hashes in the format: pbkdf2:<iterations>:<salt_hex>:<hash_hex>
Compatible with the Node.js seed-kv.mjs password format.
"""

import hashlib
import os
import sys
import getpass


def hash_password(password: str, iterations: int = 100_000) -> str:
    """
    Hash a password using PBKDF2-SHA256.
    
    Args:
        password: The plain text password to hash
        iterations: Number of PBKDF2 iterations (default: 100,000)
    
    Returns:
        Hashed password in format: pbkdf2:<iterations>:<salt_hex>:<hash_hex>
    """
    # Generate random 16-byte salt
    salt = os.urandom(16)
    
    # Derive key using PBKDF2
    dk = hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt,
        iterations,
        dklen=32  # 256 bits = 32 bytes
    )
    
    # Convert to hex strings
    salt_hex = salt.hex()
    hash_hex = dk.hex()
    
    return f"pbkdf2:{iterations}:{salt_hex}:{hash_hex}"


def verify_password(plain: str, stored: str) -> bool:
    """
    Verify a plain text password against a stored hash.
    
    Args:
        plain: The plain text password to verify
        stored: The stored hash in format: pbkdf2:<iterations>:<salt_hex>:<hash_hex>
    
    Returns:
        True if password matches, False otherwise
    """
    try:
        # Parse stored hash
        parts = stored.split(':')
        if len(parts) != 4 or parts[0] != 'pbkdf2':
            return False
        
        iterations = int(parts[1])
        salt_hex = parts[2]
        hash_hex = parts[3]
        
        # Safety: limit iterations to prevent DoS
        iterations = min(iterations, 100_000)
        
        # Convert hex back to bytes
        salt = bytes.fromhex(salt_hex)
        
        # Derive key from plain password
        dk = hashlib.pbkdf2_hmac(
            'sha256',
            plain.encode('utf-8'),
            salt,
            iterations,
            dklen=32
        )
        
        # Compare hashes
        return dk.hex() == hash_hex
    
    except (ValueError, IndexError):
        return False


def main():
    if len(sys.argv) < 2:
        print("Usage: python hash-password.py <password> [verify_hash]")
        print()
        print("Examples:")
        print("  python hash-password.py mypassword")
        print("  python hash-password.py mypassword pbkdf2:100000:abc123...:def456...")
        print()
        print("Or run interactively:")
        print("  python hash-password.py")
        sys.exit(1)
    
    if len(sys.argv) == 2:
        password = sys.argv[1]
        hashed = hash_password(password)
        print(f"Hashed password:\n{hashed}")
    
    elif len(sys.argv) == 3:
        password = sys.argv[1]
        stored_hash = sys.argv[2]
        if verify_password(password, stored_hash):
            print("✓ Password matches!")
        else:
            print("✗ Password does not match!")
            sys.exit(1)


if __name__ == '__main__':
    if len(sys.argv) == 1:
        # Interactive mode
        print("Password Hashing Tool (PBKDF2-SHA256)")
        print("=" * 40)
        
        while True:
            choice = input("\n1. Hash a password\n2. Verify password\n3. Exit\nChoice: ").strip()
            
            if choice == '1':
                password = getpass.getpass("Enter password: ")
                confirm = getpass.getpass("Confirm password: ")
                if password == confirm:
                    hashed = hash_password(password)
                    print(f"\nHashed:\n{hashed}\n")
                else:
                    print("Passwords don't match!")
            
            elif choice == '2':
                password = getpass.getpass("Enter password: ")
                stored = input("Enter stored hash: ").strip()
                if verify_password(password, stored):
                    print("✓ Password matches!")
                else:
                    print("✗ Password does not match!")
            
            elif choice == '3':
                break
            
            else:
                print("Invalid choice")
    else:
        main()
