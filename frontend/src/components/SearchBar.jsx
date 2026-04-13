import { Search, Filter } from 'lucide-react';

export default function SearchBar({ filters, cameras, onFilterChange, onSearch }) {
  const handleChange = (key, value) => {
    onFilterChange({ ...filters, [key]: value });
  };

  return (
    <div className="search-bar">
      <div className="search-input-wrap">
        <Search size={18} />
        <input
          type="text"
          placeholder="Search events, plates..."
          value={filters.search || ''}
          onChange={(e) => handleChange('search', e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSearch()}
        />
      </div>
      <input
        type="text"
        placeholder="Plate number..."
        value={filters.plate || ''}
        onChange={(e) => handleChange('plate', e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSearch()}
        className="search-plate"
      />
      <select
        value={filters.cameraId || ''}
        onChange={(e) => handleChange('cameraId', e.target.value)}
      >
        <option value="">All cameras</option>
        {cameras.map((c) => (
          <option key={c._id} value={c._id}>{c.name}</option>
        ))}
      </select>
      <select
        value={filters.tag || ''}
        onChange={(e) => handleChange('tag', e.target.value)}
      >
        <option value="">All types</option>
        <option value="person">Person</option>
        <option value="vehicle">Vehicle</option>
        <option value="auto-watch">Auto-watch</option>
        <option value="ipcam">IP Camera</option>
      </select>
      <input
        type="date"
        value={filters.dateFrom || ''}
        onChange={(e) => handleChange('dateFrom', e.target.value)}
      />
      <input
        type="date"
        value={filters.dateTo || ''}
        onChange={(e) => handleChange('dateTo', e.target.value)}
      />
      <button className="btn btn-primary" onClick={onSearch}>
        <Filter size={16} /> Filter
      </button>
    </div>
  );
}
