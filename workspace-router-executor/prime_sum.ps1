$primes = @()
for ($n = 2; $n -lt 1000; $n++) {
    $isPrime = $true
    if ($n -eq 2) {
        $isPrime = $true
    } elseif ($n % 2 -eq 0) {
        $isPrime = $false
    } else {
        for ($i = 3; $i -le [math]::Sqrt($n); $i += 2) {
            if ($n % $i -eq 0) {
                $isPrime = $false
                break
            }
        }
    }
    if ($isPrime) {
        $primes += $n
    }
}
$primes | Measure-Object -Sum | Select-Object -ExpandProperty Sum
