const GOOGLE_API_KEY = 'AIzaSyAndDn46ioSltBCezx2KUtpFZ1AlAh1Pu0';
const googleUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=50.075538,14.4378&radius=3000&type=restaurant&keyword=restaurace|bistro|kavárna&language=cs&key=${GOOGLE_API_KEY}`;

fetch(googleUrl).then(r=>r.json()).then(data=>{
    let restaurants = data.results
      .filter(el => {
        if (el.business_status && el.business_status !== 'OPERATIONAL') return false;
        if (el.opening_hours && el.opening_hours.open_now === false) return false;
        if (el.types) {
          const badTypes = ['lodging', 'hotel', 'shopping_mall', 'department_store'];
          if (el.types.some(t => badTypes.includes(t))) return false;
        }
        const nameLower = el.name ? el.name.toLowerCase() : '';
        const badNames = ['hotel', 'penzion', 'pension', 'ubytování', 'hostel', 'obchodní centrum', 'aupark', 'futurum', 'tesco', 'kaufland', 'albert', 'kfc', 'mcdonald'];
        const hasBadName = badNames.some(bn => nameLower.includes(bn) || nameLower.startsWith('oc '));
        if (hasBadName) return false;
        return true;
      });
      
    console.log('Filtered restaurants:', restaurants.length);
    console.log(restaurants.map(r => r.name));
}).catch(console.error);
