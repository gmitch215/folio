function leaf($i) { return ($i * 31 + 7) % 1000003; }
function mid($i) { $s = 0; for ($k = 0; $k < 16; $k++) { $s = ($s + leaf($i + $k)) % 1000003; } return $s; }
function top($i) { return (mid($i) ^ leaf($i >> 1)) % 1000003; }
function gen($n) { for ($i = 0; $i < $n; $i++) { $t = 0; for ($k = 0; $k < 8; $k++) { $t = ($t + leaf($i * 8 + $k)) % 1000003; } yield $t; } }
class Bag { private $d = ['x' => 3, 'y' => 5]; public function __get($n) { return $this->d[$n] * 2; } }
$sum = 0; $str = ''; $arr = [];
$bag = new Bag();
for ($i = 0; $i < 9000000; $i++) {
	$sum = ($sum + top($i)) % 1000003;
	$sum = ($sum + $bag->x) % 1000003;
	$arr[$i % 512] = $sum;
	if ($i % 97 == 0) { $str .= $i; }
	if ($i % 400000 == 0) { echo "A $i $sum\n"; }
}
echo "A-done $sum\n";
$mapped = array_map(function ($v) { return mid($v) + leaf($v); }, range(1, 1500000));
$sum = ($sum + array_sum($mapped)) % 1000003;
echo "B-done $sum\n";
foreach (gen(4500000) as $v) { $sum = ($sum + $v) % 1000003; }
echo "C-done $sum\n";
for ($i = 0; $i < 2000000; $i++) { $sum = ($sum + top($i)) % 1000003; }
echo "D-done $sum\n";
echo $sum, ':', strlen($str), ':', md5($str), ':', count($arr), "\n";
